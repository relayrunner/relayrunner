import { readRunnerOrder } from "@relayrunner/runner-order";
import { accountUsage } from "../actions-billing.ts";
import { DurableObject } from "cloudflare:workers";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { appInstallationToken, listOrgRunners, type OrgRunner } from "../github-app.ts";
import { installationRunnerScope } from "../installations.ts";
import {
  fetchGroupAccess,
  matchLabels,
  parseStoredLabels,
  runnerStatus,
  type GroupAccess,
} from "../github-runners.ts";
import {
  canClaim,
  chooseMachine,
  decideRoute,
  holdsMachine,
  machineLabels,
  lastPicked,
  newRouteId,
  pausedMatches,
  routeLabel,
  ROUTE_TTL_MS,
  type Candidate,
  type MachinePick,
  type QueuedJob,
  type Route,
  type RouteDecision,
} from "../routing.ts";

export interface PickedJob {
  workspaceId: string;
  installationId: number;
  repositoryId: number;
  repo: string;
  runId: number;
  // Labels a machine must all have (the relay's `machine` input). Empty: don't use machines.
  machine: string[];
  // The GitHub-hosted label(s) (the relay's `github` input). Empty: don't use GitHub-hosted.
  github: string[];
  // The Blacksmith label (the relay's `blacksmith` input). Empty: don't use Blacksmith.
  blacksmith: string[];
  // Public repos never go to a machine: anyone could run code on it with a pull request.
  private: boolean;
}

const ROUTE_KEY = "route:";
// How long a GitHub org's runner group access is reused before it's read again. Runner status is
// read fresh on every pick; groups change rarely and take a few calls to read.
const GROUP_ACCESS_TTL_MS = 5 * 60_000;

// One per workspace, addressed by workspace id. Decides where each picked job's run goes and
// keeps the routes it hands out (src/routing.ts), so the job queued on a route's label can find
// its machine.
export class Router extends DurableObject<Env> {
  // Runner group access per installation, kept in memory while the object is awake.
  private groupAccess = new Map<number, { at: number; access: Map<number, GroupAccess> }>();

  /**
   * Where the run's next job goes, walking the workspace's runner order: a machine route's
   * `rr-<id>`, the job's own `github` label, or no runner and the reason. A GitHub step with a
   * minutes limit passes the job on once the job's account nears its included quota.
   */
  async route(job: PickedJob): Promise<RouteDecision> {
    const db = createDb(this.env.DB);
    const [workspace] = await db
      .select({ runnerOrder: schema.workspace.runnerOrder })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, job.workspaceId))
      .limit(1);
    return decideRoute(
      readRunnerOrder(workspace?.runnerOrder),
      job,
      () => this.pickMachine(job),
      // The job's own account: each GitHub account has its own quota, never pooled (#117).
      () => accountUsage(db, job.installationId),
    );
  }

  // A route to a free machine with the job's labels, the paused machines when every one with the
  // labels is paused, or null.
  private pickMachine(job: PickedJob): Promise<MachinePick> {
    // One decision at a time, so two picks can't both see the same machine as free.
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const routes = await this.routes(now);
      const held = new Set(routes.filter((r) => holdsMachine(r, now)).map((r) => r.machineId));

      const machines = await createDb(this.env.DB)
        .select({
          id: schema.machine.id,
          name: schema.machine.name,
          os: schema.machine.os,
          arch: schema.machine.arch,
          pausedAt: schema.machine.pausedAt,
          source: schema.machine.source,
          installationId: schema.machine.installationId,
          githubRunnerId: schema.machine.githubRunnerId,
          routingLabel: schema.machine.routingLabel,
          githubLabels: schema.machine.githubLabels,
        })
        .from(schema.machine)
        .where(
          and(
            eq(schema.machine.workspaceId, job.workspaceId),
            isNull(schema.machine.revokedAt),
            or(
              isNotNull(schema.machine.tokenHash),
              and(eq(schema.machine.source, "github"), isNotNull(schema.machine.routingLabel)),
            ),
          ),
        );
      // An org runner only serves its own org's repos, so a runner added from another
      // installation never fits this job.
      const fits = machines.filter(
        (machine) => machine.source !== "github" || machine.installationId === job.installationId,
      );
      const pool = fits.map((machine) => ({
        id: machine.id,
        name: machine.name,
        labels:
          machine.source === "github"
            ? matchLabels(parseStoredLabels(machine.githubLabels))
            : machineLabels(machine),
        paused: machine.pausedAt !== null,
      }));
      // Paused machines can't be picked, so there's no need to ask for their live status.
      const live = fits.filter((machine) => !held.has(machine.id) && machine.pausedAt === null);
      const runners = live.some((machine) => machine.source === "github")
        ? await this.orgRunners(job)
        : null;
      const candidates: Candidate[] = await Promise.all(
        live.map(async (machine): Promise<Candidate> => {
          const base = pool.find((entry) => entry.id === machine.id)!;
          if (machine.source !== "github")
            return { ...base, ...(await this.env.MACHINE_LINK.getByName(machine.id).status()) };
          const runner = runners?.runners.find((r) => r.id === machine.githubRunnerId);
          return {
            ...base,
            ...runnerStatus(runner, runner && runners?.access.get(runner.id), {
              id: job.repositoryId,
              private: job.private,
            }),
          };
        }),
      );
      const machine = chooseMachine(candidates, held, lastPicked(routes), job.machine);
      if (!machine) {
        const paused = pausedMatches(pool, job.machine);
        return paused.length > 0 ? { paused } : null;
      }

      const routingLabel = fits.find((m) => m.id === machine.id)?.routingLabel ?? undefined;
      const route: Route = {
        id: newRouteId(),
        machineId: machine.id,
        machineName: machine.name,
        installationId: job.installationId,
        repo: job.repo,
        repositoryId: job.repositoryId,
        runId: job.runId,
        createdAt: now,
        state: "reserved",
        ...(routingLabel ? { routingLabel } : {}),
      };
      await this.ctx.storage.put(ROUTE_KEY + route.id, route);
      return routingLabel ?? routeLabel(route.id);
    });
  }

  // The job's org's self-hosted runners, read fresh, with their group access (cached), or null
  // when GitHub can't be reached: added runners then sit this pick out. A personal account has
  // none.
  private async orgRunners(
    job: PickedJob,
  ): Promise<{ runners: OrgRunner[]; access: Map<number, GroupAccess> } | null> {
    const org = job.repo.split("/")[0];
    try {
      const token = await appInstallationToken(this.env, job.installationId);
      const runners = await listOrgRunners(token, org);
      const cached = this.groupAccess.get(job.installationId);
      // A personal account has no org runners. Adopting its repo runners is #162.
      const scope = await installationRunnerScope(
        createDb(this.env.DB),
        job.installationId,
        job.repo,
      );
      if (scope.kind === "repo") return { runners: [], access: new Map() };
      const known = cached && runners.every((runner) => cached.access.has(runner.id));
      if (cached && known && Date.now() - cached.at < GROUP_ACCESS_TTL_MS)
        return { runners, access: cached.access };
      const access = await fetchGroupAccess(token, org, runners);
      this.groupAccess.set(job.installationId, { at: Date.now(), access });
      return { runners, access };
    } catch (error) {
      console.warn(
        JSON.stringify({
          msg: "github runners unavailable",
          installationId: job.installationId,
          org,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  /**
   * Claims the route a pick made to a runner added from GitHub, for the `queued` job that carries
   * the runner's label: same machine, repo and run, not yet claimed by another job. Nothing is
   * minted; GitHub delivers the job to the runner. Null when no route fits (the label was used by
   * hand, or the route expired). A redelivery returns the same route.
   */
  async claimRunner(machineId: string, job: QueuedJob): Promise<Route | null> {
    const now = Date.now();
    const routes = (await this.routes(now))
      .filter((route) => route.machineId === machineId && route.state !== "done")
      .filter((route) => canClaim(route, job))
      // The job's own claim first (a redelivery), then the oldest open route.
      .sort(
        (a, b) =>
          Number(b.jobId === job.jobId) - Number(a.jobId === job.jobId) ||
          a.createdAt - b.createdAt,
      );
    const route = routes[0];
    if (!route) return null;
    const claimed: Route = { ...route, jobId: job.jobId, state: "dispatched" };
    await this.ctx.storage.put(ROUTE_KEY + route.id, claimed);
    return claimed;
  }

  /**
   * Ends the route a job on an added runner claimed, once GitHub says the job started (or
   * finished): the runner's own busy status covers it from then on. Returns the machine id when a
   * route matched, for the Activity page.
   */
  async releaseRunnerJob(machineId: string, job: QueuedJob): Promise<string | null> {
    const routes = await this.routes(Date.now());
    const route = routes.find((r) => r.machineId === machineId && r.jobId === job.jobId);
    if (!route) return null;
    if (route.state !== "done")
      await this.ctx.storage.put(ROUTE_KEY + route.id, { ...route, state: "done" });
    return machineId;
  }

  /**
   * The route a queued `rr-<id>` job may run on, or null when the label is unknown, expired, or
   * belongs to another repo, run or job, or once the machine has taken the job. Claiming again with the same job returns the route again,
   * so a redelivered webhook can retry the hand-off.
   */
  async claim(routeId: string, job: QueuedJob): Promise<Route | null> {
    const route = await this.ctx.storage.get<Route>(ROUTE_KEY + routeId);
    if (!route || route.state === "done" || Date.now() - route.createdAt > ROUTE_TTL_MS)
      return null;
    // A route to an added GitHub runner is claimed by the runner's own label (claimRunner).
    if (route.routingLabel || !canClaim(route, job)) return null;
    const claimed: Route = {
      ...route,
      jobId: job.jobId,
      state: route.state === "reserved" ? "dispatched" : route.state,
    };
    await this.ctx.storage.put(ROUTE_KEY + routeId, claimed);
    return claimed;
  }

  /**
   * The machine a route sent `job` to, without claiming anything: for the Activity page, when a
   * job's later webhooks arrive before (or without) its `queued` one. Null when the route is
   * unknown, expired, or belongs to another repo, run or job.
   */
  async machineFor(routeId: string, job: QueuedJob): Promise<string | null> {
    const route = await this.ctx.storage.get<Route>(ROUTE_KEY + routeId);
    if (!route || Date.now() - route.createdAt > ROUTE_TTL_MS || !canClaim(route, job)) return null;
    return route.machineId;
  }

  /** Stops a route holding its machine. MachineLink calls this when the machine reports in. */
  async release(routeId: string): Promise<void> {
    const route = await this.ctx.storage.get<Route>(ROUTE_KEY + routeId);
    if (route && route.state !== "done")
      await this.ctx.storage.put(ROUTE_KEY + routeId, { ...route, state: "done" });
  }

  // Every route still kept, after dropping the expired ones.
  private async routes(now: number) {
    const stored = await this.ctx.storage.list<Route>({ prefix: ROUTE_KEY });
    const expired = [...stored].filter(([, r]) => now - r.createdAt > ROUTE_TTL_MS).map(([k]) => k);
    // delete() takes at most 128 keys at a time.
    if (expired.length) await this.ctx.storage.delete(expired.slice(0, 128));
    return [...stored.values()].filter((r) => now - r.createdAt <= ROUTE_TTL_MS);
  }
}
