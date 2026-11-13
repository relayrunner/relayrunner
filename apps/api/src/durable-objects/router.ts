import { type RelayInputs, readRunnerOrder } from "@relayrunner/runner-order";
import { accountUsage } from "../actions-billing.ts";
import { DurableObject } from "cloudflare:workers";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import {
  appInstallationToken,
  listOrgRunners,
  userCanReadRepo,
  type OrgRunner,
} from "../github-app.ts";
import { installationRunnerScope } from "../installations.ts";
import { inWorkspace } from "../machines.ts";
import { runStartersForJobs } from "../job-starters.ts";
import { setJobMachine } from "../jobs.ts";
import { findRepo } from "../repositories.ts";
import {
  cleared,
  healthGate,
  healthId,
  updateHealth,
  type JobSignal,
  type LabelHealth,
} from "../provider-health.ts";
import { earlierPick, jobKey } from "../route-decisions.ts";
import type { RetryPick } from "../retries.ts";
import { errorMessage } from "../webhook-queue.ts";
import {
  fetchGroupAccess,
  matchLabels,
  parseStoredLabels,
  runnerStatus,
  type GroupAccess,
} from "../github-runners.ts";
import {
  admits,
  canClaim,
  chooseAndHold,
  chooseMachine,
  decideRoute,
  fullMachines,
  retryOrder,
  heldSlots,
  isolatedLabels,
  machineLabels,
  mayReroute,
  runsIsolated,
  lastPicked,
  needsOwnerAccess,
  newRouteId,
  routeLabel,
  unavailableMachines,
  waitingDecision,
  waitingLine,
  waitsForMachine,
  ROUTE_TTL_MS,
  type Candidate,
  type HeldSlots,
  type JobStarters,
  type MachinePick,
  type QueuedJob,
  type Rerun,
  type Route,
  type RouteDecision,
  type Waiting,
} from "../routing.ts";

// The relay's inputs (RelayInputs): labels a machine must all have (`machine`), the GitHub-hosted
// label (`github`), and each hosted provider's label. Empty: don't use that provider.
export interface PickedJob extends JobStarters, RelayInputs {
  workspaceId: string;
  installationId: number;
  repositoryId: number;
  repo: string;
  runId: number;
  // Public repos never go to a machine: anyone could run code on it with a pull request.
  private: boolean;
  // startedBy and triggeredBy (JobStarters): who started the run and this attempt. A machine
  // that's `only_me` takes the job only when both are its owner.
  // Set when this attempt is an automatic retry (src/retries.ts): where the job failed and where
  // the retry should go.
  retry?: RetryPick | null;
}

const ROUTE_KEY = "route:";
// Jobs waiting for a machine slot (Router.wait), by the route id their pick answered.
const WAIT_KEY = "wait:";
// How often the Router looks for a free slot while jobs wait. A machine finishing a job also
// wakes it (release).
const WAIT_POLL_MS = 10_000;

interface WaitingJob extends Waiting {
  job: PickedJob;
}
// Each hosted provider runner type's health (src/provider-health.ts), by healthId.
const HEALTH_KEY = "health:";

// How long a GitHub org's runner group access is reused before it's read again. Groups change
// rarely and take a few calls to read.
const GROUP_ACCESS_TTL_MS = 5 * 60_000;
// How long a machine owner's read access to a repo is reused before GitHub is asked again.
const OWNER_ACCESS_TTL_MS = 10 * 60_000;
// How long the dashboard reuses an org's runner list (status, busy, labels).
const RUNNER_LIST_TTL_MS = 30_000;
// How old a runner list a pick accepts, so a push that starts many runs at once asks GitHub once
// rather than once per run. Short, since a runner's busy status decides whether it gets the job.
const PICK_RUNNER_LIST_TTL_MS = 5_000;

// One per workspace, addressed by workspace id. Decides where each picked job's run goes and
// keeps the routes it hands out (src/routing.ts), so the job queued on a route's label can find
// its machine.
export class Router extends DurableObject<Env> {
  // What GitHub said, kept in memory while the object is awake: runner group access and each
  // org's runner list by installation id, and whether a machine owner can read a repo by
  // `<installation>:<repo id>:<owner GitHub id>`.
  private groupAccess = new Recent<number, Map<number, GroupAccess>>();
  private runnerLists = new Recent<number, OrgRunner[]>();
  private ownerAccess = new Recent<string, boolean>();

  /**
   * An org's self-hosted runners for the dashboard's Runners and Router pages, reused for
   * RUNNER_LIST_TTL_MS so the pages' refreshes don't each ask GitHub. Null when GitHub can't be
   * asked.
   */
  async githubRunners(installationId: number, org: string): Promise<OrgRunner[] | null> {
    try {
      return await this.runnerList(RUNNER_LIST_TTL_MS, installationId, org);
    } catch (error) {
      console.warn(
        JSON.stringify({
          msg: "github runners unavailable",
          installationId,
          org,
          error: errorMessage(error),
        }),
      );
      return null;
    }
  }

  // An org's runner list, no older than `maxAge`. The dashboard and picks share one copy.
  private runnerList(maxAge: number, installationId: number, org: string): Promise<OrgRunner[]> {
    return this.runnerLists.get(installationId, maxAge, async () =>
      listOrgRunners(await appInstallationToken(this.env, installationId), org),
    );
  }

  /**
   * Whether a machine's owner can read the job's repo, as the job's installation sees it. Reused
   * for OWNER_ACCESS_TTL_MS. No owner, or GitHub can't be asked: no, and the machine sits this job
   * out (nothing is cached, so the next pick asks again).
   */
  private async ownerCanRead(
    machineId: string,
    ownerGithubId: number | null,
    job: PickedJob,
  ): Promise<boolean> {
    let allowed = false;
    if (ownerGithubId !== null) {
      const key = `${job.installationId}:${job.repositoryId}:${ownerGithubId}`;
      try {
        allowed = await this.ownerAccess.get(key, OWNER_ACCESS_TTL_MS, async () =>
          userCanReadRepo(
            await appInstallationToken(this.env, job.installationId),
            job.repo,
            ownerGithubId,
          ),
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            msg: "machine owner access unknown",
            machineId,
            repo: job.repo,
            error: errorMessage(error),
          }),
        );
      }
    }
    if (!allowed)
      console.log(
        JSON.stringify({
          msg: "machine skipped: owner can't read repo",
          machineId,
          repo: job.repo,
        }),
      );
    return allowed;
  }

  /**
   * Where the run's next job goes, walking the workspace's runner order: a machine route's
   * `rr-<id>`, the job's own `github` label, or no runner and the reason. A GitHub step with a
   * minutes limit passes the job on once the job's account nears its included quota.
   */
  async route(job: PickedJob): Promise<RouteDecision> {
    const db = createDb(this.env.DB);
    const [[workspace]] = await Promise.all([
      db
        .select({
          runnerOrder: schema.workspace.runnerOrder,
          skipUnhealthy: schema.workspace.skipUnhealthyRunners,
        })
        .from(schema.workspace)
        .where(eq(schema.workspace.id, job.workspaceId))
        .limit(1),
      // Jobs already waiting get a free slot before this one can.
      this.drain(),
    ]);
    const decision = await decideRoute(
      retryOrder(readRunnerOrder(workspace?.runnerOrder), job.retry),
      job,
      () => this.pickMachine(job),
      // The job's own account: each GitHub account has its own quota, never pooled (#117).
      () => accountUsage(db, job.installationId),
      // Off: every hosted step takes its jobs, however they've been going.
      workspace?.skipUnhealthy === false
        ? undefined
        : (key, label) => this.checkHealth(healthId(key, label)),
    );
    return waitsForMachine(decision) ? this.wait(job, decision) : decision;
  }

  // Every machine that fits is full and nothing else in the order takes the job: it waits in line
  // for a slot instead of failing. The pick answers the route's label now, so the job sits queued
  // on GitHub (up to its 24 hours) like any job waiting for a self-hosted runner; drain makes the
  // route once a machine has room.
  private async wait(
    job: PickedJob,
    decision: Extract<RouteDecision, { runner: null }>,
  ): Promise<RouteDecision> {
    const waiting: WaitingJob = {
      id: newRouteId(),
      queuedAt: Date.now(),
      repositoryId: job.repositoryId,
      runId: job.runId,
      job,
    };
    await this.ctx.storage.put(WAIT_KEY + waiting.id, waiting);
    await this.wakeIn(WAIT_POLL_MS);
    console.log(
      JSON.stringify({
        msg: "relayrunner job waiting for a machine",
        routeId: waiting.id,
        repo: job.repo,
        runId: job.runId,
        reason: decision.reason,
      }),
    );
    return waitingDecision(decision, routeLabel(waiting.id));
  }

  /**
   * Gives free machine slots to waiting jobs, longest waiting first. A job a machine takes gets its
   * route under the id its pick answered, and once its `queued` webhook has come, goes to the
   * machine. Jobs that want the same machines as one that found none free wait their turn behind it.
   */
  async drain(): Promise<void> {
    const now = Date.now();
    const stored = await this.ctx.storage.list<WaitingJob>({ prefix: WAIT_KEY });
    if (stored.size === 0) return;
    const line = waitingLine([...stored.values()], now);
    if (line.length < stored.size) {
      const live = new Set(line.map((entry) => WAIT_KEY + entry.id));
      const expired = [...stored.keys()].filter((key) => !live.has(key));
      // delete() takes at most 128 keys at a time.
      for (let i = 0; i < expired.length; i += 128)
        await this.ctx.storage.delete(expired.slice(i, i + 128));
    }
    const stuck = new Set<string>();
    let left = 0;
    for (const entry of line) {
      const wants = wantsKey(entry.job);
      if (stuck.has(wants)) {
        left++;
        continue;
      }
      const pick = await this.pickMachine(entry.job, undefined, entry);
      if (typeof pick !== "string") {
        stuck.add(wants);
        left++;
        continue;
      }
      if (!(await this.handOff(entry))) left++;
    }
    if (left > 0) await this.wakeIn(WAIT_POLL_MS);
  }

  // Sends a waiting job its machine took to that machine, once its `queued` webhook has said which
  // job it is (before that, the route waits for claim like any other). False when sending failed:
  // the job goes back in line, in its old place.
  private async handOff(entry: WaitingJob): Promise<boolean> {
    const route = await this.ctx.storage.get<Route>(ROUTE_KEY + entry.id);
    if (route?.jobId === undefined) return true;
    try {
      await setJobMachine(createDb(this.env.DB), route.jobId, route.machineId);
      const result = await this.env.MACHINE_LINK.getByName(route.machineId).run({
        route,
        workspaceId: entry.job.workspaceId,
      });
      console.log(
        JSON.stringify({
          msg: "relayrunner waiting job sent",
          routeId: route.id,
          machineId: route.machineId,
          jobId: route.jobId,
          waitedMs: Date.now() - entry.queuedAt,
          result,
        }),
      );
      return true;
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "relayrunner waiting job not sent",
          routeId: route.id,
          machineId: route.machineId,
          error: errorMessage(error),
        }),
      );
      await this.ctx.storage.delete(ROUTE_KEY + entry.id);
      await this.ctx.storage.put(WAIT_KEY + entry.id, { ...entry, jobId: route.jobId });
      return false;
    }
  }

  async alarm() {
    await this.drain();
  }

  // Looks for free slots again within `ms`, unless an earlier look is already set.
  private async wakeIn(ms: number) {
    const at = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /**
   * Drops a waiting job that ended before any machine took it, such as a cancelled run. Its
   * `completed` webhook calls this.
   */
  async dropWaiting(routeId: string, job: QueuedJob): Promise<void> {
    const waiting = await this.ctx.storage.get<WaitingJob>(WAIT_KEY + routeId);
    if (waiting && canClaim(waiting, job)) await this.ctx.storage.delete(WAIT_KEY + routeId);
  }

  // Null when the runner type may take the job, marking it as the trial when it's due one; else
  // why it's skipped.
  private async checkHealth(id: string) {
    const state = await this.ctx.storage.get<LabelHealth>(HEALTH_KEY + id);
    const now = Date.now();
    const gate = healthGate(state, now);
    if (gate === "ok") return null;
    if (gate === "trial") {
      await this.ctx.storage.put(HEALTH_KEY + id, { ...state, trialAt: now });
      console.log(JSON.stringify({ msg: "provider health trial", id }));
      return null;
    }
    return gate;
  }

  /** The 15-minute sweep's recent jobs on hosted provider labels (sweepProviderHealth). */
  async updateHealth(jobs: JobSignal[], now: number): Promise<void> {
    const stored = await this.ctx.storage.list<LabelHealth>({ prefix: HEALTH_KEY });
    const states = new Map(
      [...stored].map(([key, state]) => [key.slice(HEALTH_KEY.length), state]),
    );
    const puts: Record<string, LabelHealth> = {};
    const deletes: string[] = [];
    for (const [id, state] of updateHealth(states, jobs, now)) {
      if (!state) {
        deletes.push(HEALTH_KEY + id);
        continue;
      }
      puts[HEALTH_KEY + id] = state;
      if ((state.trippedAt === null) !== (states.get(id)?.trippedAt == null))
        console.log(
          JSON.stringify({
            msg: state.trippedAt === null ? "provider recovered" : "provider unhealthy",
            id,
            misses: state.misses,
          }),
        );
    }
    // put() and delete() take at most 128 keys at a time; a workspace has far fewer runner types.
    if (Object.keys(puts).length) await this.ctx.storage.put(puts);
    if (deletes.length) await this.ctx.storage.delete(deletes);
  }

  /** The runner types the Router skips now, for the Router page. */
  async unhealthy() {
    const stored = await this.ctx.storage.list<LabelHealth>({ prefix: HEALTH_KEY });
    return [...stored.values()]
      .filter((state) => state.trippedAt !== null)
      .map(({ key, label, misses, retryAt }) => ({ key, label, misses, retryAt }));
  }

  /** "Try again now": clears a runner type, so jobs go to it again. */
  async clearHealth(key: string, label: string): Promise<void> {
    const id = HEALTH_KEY + healthId(key, label);
    const state = await this.ctx.storage.get<LabelHealth>(id);
    if (state?.trippedAt != null) await this.ctx.storage.put(id, cleared(state, Date.now()));
  }

  // A route to a free machine with the job's labels whose sharing takes the job, else why none
  // could (unavailableMachines), or null.
  //
  // The slow reads (D1, GitHub, each machine's live status) happen first, with nothing locked, so
  // one workspace's picks run side by side and a slow GitHub call holds up only its own pick. Only
  // the choice and the route that reserves the machine run one at a time (reserve), against the
  // routes as they stand then, so two picks can't both take the same machine.
  private async pickMachine(
    job: PickedJob,
    rerun?: Rerun,
    waiting?: Waiting,
  ): Promise<MachinePick> {
    const db = createDb(this.env.DB);
    const machines = await db
      .select({
        id: schema.machine.id,
        name: schema.machine.name,
        os: schema.machine.os,
        arch: schema.machine.arch,
        isolatedOs: schema.machine.isolatedOs,
        isolatedArch: schema.machine.isolatedArch,
        pausedAt: schema.machine.pausedAt,
        source: schema.machine.source,
        installationId: schema.machine.installationId,
        githubRunnerId: schema.machine.githubRunnerId,
        routingLabel: schema.machine.routingLabel,
        githubLabels: schema.machine.githubLabels,
        sharing: schema.machine.sharing,
        ownerName: schema.user.name,
        ownerGithubId: schema.account.accountId,
      })
      .from(schema.machine)
      .leftJoin(schema.user, eq(schema.user.id, schema.machine.userId))
      // The owner's GitHub account, which `only_me` matches the job's starters against.
      .leftJoin(
        schema.account,
        and(
          eq(schema.account.userId, schema.machine.userId),
          eq(schema.account.providerId, "github"),
        ),
      )
      .where(
        and(
          // Its members' connected machines, wherever they enrolled them, and its own adopted
          // runners (#318). A connected machine can be in several workspaces, each with its own
          // Router, so reserve below also takes the machine's own hold (MachineLink.reserve).
          inWorkspace(db, job.workspaceId),
          isNull(schema.machine.revokedAt),
          or(
            isNotNull(schema.machine.tokenHash),
            and(eq(schema.machine.source, "github"), isNotNull(schema.machine.routingLabel)),
          ),
        ),
      );
    // An org runner only serves its own org's repos, so a runner added from another
    // installation never fits this job. An owner with two GitHub accounts linked would list a
    // machine twice: keep its first row.
    const seen = new Set<string>();
    // A re-run or a waiting job keeps its `rr-<id>` label, which only a connected machine's minted
    // runner carries.
    const fits = machines
      .filter((machine) => !seen.has(machine.id) && Boolean(seen.add(machine.id)))
      .filter(
        (machine) =>
          machine.source !== "github" ||
          (!rerun && !waiting && machine.installationId === job.installationId),
      );
    const pool = fits.map((machine) => ({
      id: machine.id,
      name: machine.name,
      labels:
        machine.source === "github"
          ? matchLabels(parseStoredLabels(machine.githubLabels))
          : machineLabels(machine),
      isolatedLabels: isolatedLabels(machine),
      paused: machine.pausedAt !== null,
      sharing: machine.sharing,
      ownerGithubId: githubId(machine.ownerGithubId),
      ownerName: machine.ownerName,
    }));
    // Paused machines can't be picked, so there's no need to ask for their live status.
    // Nor for those whose sharing won't take this job. A machine this Router already holds may
    // still have a free slot, so held ones are asked too (reserve counts them under the lock).
    const admitted = fits.filter(
      (machine) =>
        machine.pausedAt === null &&
        admits(
          pool.find((entry) => entry.id === machine.id)!,
          job,
        ),
    );
    // A connected machine shared with anyone only takes the job if its owner can read the repo.
    // A runner added from GitHub is the org's own, already limited by its runner group.
    const readable = await Promise.all(
      admitted.map((machine) => {
        const entry = pool.find((e) => e.id === machine.id)!;
        if (machine.source === "github" || !needsOwnerAccess(entry, job)) return true;
        return this.ownerCanRead(machine.id, entry.ownerGithubId ?? null, job);
      }),
    );
    const live = admitted.filter((_, index) => readable[index]);
    const runners = live.some((machine) => machine.source === "github")
      ? await this.orgRunners(job)
      : null;
    const candidates: Candidate[] = await Promise.all(
      live.map(async (machine): Promise<Candidate> => {
        const { ownerName: _, ...base } = pool.find((entry) => entry.id === machine.id)!;
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
    const routingLabels = new Map(fits.map((m) => [m.id, m.routingLabel ?? undefined]));
    // The OS of each machine's two places, for the route to say where its job goes.
    const places = new Map(fits.map((m) => [m.id, { host: m.os, vm: m.isolatedOs }]));
    return (
      (await this.reserve(job, candidates, routingLabels, places, rerun, waiting)) ??
      unavailableMachines(pool, job.machine, job)
    );
  }

  // Chooses among the candidates and stores the route that holds the chosen machine, one pick at a
  // time. The only I/O is storage and the chosen machine's MachineLink hold, so the lock is held
  // for milliseconds. When none has a free slot, the full ones that fit (fullMachines), else null.
  private reserve(
    job: PickedJob,
    candidates: Candidate[],
    routingLabels: Map<string, string | undefined>,
    places: Map<string, { host: string | null; vm: string | null }>,
    rerun?: Rerun,
    waiting?: Waiting,
  ): Promise<MachinePick | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const routes = await this.routes(now);
      // Checked again under the lock: another job may have taken the route since.
      const prior = rerun && routes.find((r) => r.id === rerun.routeId);
      if (rerun && !mayReroute(prior, rerun)) return null;
      // Read again under the lock: another drain may have given the waiting job a machine since,
      // or its `queued` webhook said which job it is (claim).
      const waitingNow = waiting
        ? await this.ctx.storage.get<Waiting>(WAIT_KEY + waiting.id)
        : undefined;
      if (waiting && !waitingNow) return null;
      const held = heldSlots(routes, now);
      const picked = lastPicked(routes);
      const routeId = rerun?.routeId ?? waiting?.id ?? newRouteId();
      // The job behind the route, when it's already queued (a re-run, or a waiting job claimed).
      const jobId = rerun?.jobId ?? waitingNow?.jobId;
      // A re-run tries the machine it ran on first, then any other that fits. So does a retry,
      // unless it's meant for another runner: then the machine it failed on goes last.
      const failedOn = job.retry?.failedMachineId;
      const avoid = job.retry?.runner === "other" ? failedOn : undefined;
      const preferredId = prior?.machineId ?? (avoid ? undefined : failedOn);
      const preferred = candidates.filter((c) => c.id === preferredId);
      const others = candidates.filter((c) => c.id !== avoid);
      const avoided = candidates.filter((c) => c.id === avoid);
      const choose = (from: Candidate[], taken: HeldSlots) =>
        chooseMachine(from, taken, picked, job.machine, job);
      // This Router's held routes count against each machine's slots, and a machine whose
      // MachineLink refused the hold counts as full.
      const withTaken = (taken: Set<string>): HeldSlots =>
        new Map([...held, ...[...taken].map((id) => [id, Infinity] as const)]);
      let refused = new Set<string>();
      // A connected machine may also be in other workspaces, so its own MachineLink holds a slot
      // for this route too, counting every workspace's holds: if the others took the last slot,
      // try the next machine. A runner added from GitHub belongs to one installation, so to this
      // workspace alone, and the lock here is enough.
      const machine = await chooseAndHold(
        (taken) => {
          refused = taken;
          return (
            choose(preferred, withTaken(taken)) ??
            choose(others, withTaken(taken)) ??
            choose(avoided, withTaken(taken))
          );
        },
        async (candidate) =>
          routingLabels.get(candidate.id) !== undefined ||
          this.env.MACHINE_LINK.getByName(candidate.id).reserve({
            routeId,
            workspaceId: job.workspaceId,
          }),
      );
      if (!machine) {
        const full = fullMachines(candidates, withTaken(refused), job.machine, job);
        return full ? { full } : null;
      }
      const routingLabel = routingLabels.get(machine.id);
      const isolated = runsIsolated(machine, job.machine, job.github);
      const os = places.get(machine.id)?.[isolated ? "vm" : "host"];
      const route: Route = {
        id: routeId,
        machineId: machine.id,
        machineName: machine.name,
        installationId: job.installationId,
        repo: job.repo,
        repositoryId: job.repositoryId,
        runId: job.runId,
        createdAt: now,
        // A re-run's or claimed waiting job is already queued, so it claims the route here.
        state: jobId === undefined ? "reserved" : "dispatched",
        ...(jobId !== undefined && { jobId }),
        ...((rerun ?? waitingNow)?.runAttempt !== undefined && {
          runAttempt: (rerun ?? waitingNow)!.runAttempt,
        }),
        ...(routingLabel ? { routingLabel } : {}),
        ...(os ? { os } : {}),
        ...(isolated ? { isolated: true } : {}),
      };
      await this.ctx.storage.put(ROUTE_KEY + route.id, route);
      if (waiting) await this.ctx.storage.delete(WAIT_KEY + waiting.id);
      return routingLabel ?? routeLabel(route.id);
    });
  }

  // The job's org's self-hosted runners, read within the last few seconds, with their group access
  // (cached), or null when GitHub can't be reached: added runners then sit this pick out. A
  // personal account has none.
  private async orgRunners(
    job: PickedJob,
  ): Promise<{ runners: OrgRunner[]; access: Map<number, GroupAccess> } | null> {
    const org = job.repo.split("/")[0];
    try {
      // A personal account has no org runners. Adopting its repo runners is #162.
      const scope = await installationRunnerScope(
        createDb(this.env.DB),
        job.installationId,
        job.repo,
      );
      if (scope.kind === "repo") return { runners: [], access: new Map() };
      const runners = await this.runnerList(PICK_RUNNER_LIST_TTL_MS, job.installationId, org);
      const readAccess = async () =>
        fetchGroupAccess(await appInstallationToken(this.env, job.installationId), org, runners);
      let access = await this.groupAccess.get(job.installationId, GROUP_ACCESS_TTL_MS, readAccess);
      // A runner added since: read the groups again.
      if (!runners.every((runner) => access.has(runner.id))) {
        this.groupAccess.forget(job.installationId);
        access = await this.groupAccess.get(job.installationId, GROUP_ACCESS_TTL_MS, readAccess);
      }
      return { runners, access };
    } catch (error) {
      console.warn(
        JSON.stringify({
          msg: "github runners unavailable",
          installationId: job.installationId,
          org,
          error: errorMessage(error),
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
  async claim(routeId: string, job: QueuedJob): Promise<Route | "waiting" | null> {
    // A job still waiting for a machine: drain sends it once a machine takes it.
    const waited = await this.claimWaiting(routeId, job);
    if (waited === null) return null;
    if (waited) {
      await this.drain();
      return waited;
    }
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

  // Notes which job a waiting route's label went to, so drain sends it once a machine takes it.
  // Undefined when the route isn't waiting, null when the job isn't its run's. Under the same lock
  // as reserve, so a machine taking the job meanwhile can't miss which job it is; only a waiting
  // route takes the lock.
  private async claimWaiting(routeId: string, job: QueuedJob) {
    if (!(await this.ctx.storage.get(WAIT_KEY + routeId))) return undefined;
    return this.ctx.blockConcurrencyWhile(async () => {
      const waiting = await this.ctx.storage.get<WaitingJob>(WAIT_KEY + routeId);
      if (!waiting) return undefined;
      if (!canClaim(waiting, job)) return null;
      await this.ctx.storage.put(WAIT_KEY + routeId, { ...waiting, jobId: job.jobId });
      return "waiting" as const;
    });
  }

  /**
   * Routes a re-run job again on its old `rr-<id>` label. "Re-run failed jobs" doesn't re-run the
   * relay, so the job comes back on the label the earlier attempt's pick answered, whose route is
   * done or expired. When that pick was this run's (earlierPick), the route is made again under the
   * same id for this job, with that pick's inputs and this attempt's starters: the machine it ran
   * on if that one is free, else any machine the relay's labels and sharing allow. Returns the
   * claimed route, "waiting" when every machine that fits is full (it waits in line like a new
   * pick), or null when the label wasn't this run's pick, no machine can take the job, or another
   * job of this attempt already did.
   */
  async reroute(
    routeId: string,
    queued: QueuedJob & {
      runAttempt: number;
      workspaceId: string;
      installationId: number;
      repo: string;
    },
  ): Promise<Route | "waiting" | null> {
    const { runAttempt, installationId, repo: fullName } = queued;
    if (runAttempt <= 1) return null;
    const db = createDb(this.env.DB);
    const key = { repositoryId: queued.repositoryId, runId: queued.runId, runAttempt };
    const [pick, repo] = await Promise.all([
      earlierPick(db, { ...key, label: routeLabel(routeId) }),
      findRepo(db, installationId, fullName),
    ]);
    if (!pick || !repo) return null;
    const rerun: Rerun = {
      routeId,
      jobId: queued.jobId,
      ...key,
      pickedAttempt: pick.runAttempt,
    };
    const stored = await this.ctx.storage.get<Route>(ROUTE_KEY + routeId);
    if (!mayReroute(stored, rerun)) return null;
    // Until this attempt's workflow_run arrives, nobody started it: only machines shared with
    // anyone can take the job then.
    const starters = await runStartersForJobs(db, [key], new Map([[jobKey(key), pick]]), jobKey);
    const job: PickedJob = {
      workspaceId: queued.workspaceId,
      installationId,
      repositoryId: repo.id,
      repo: fullName,
      runId: queued.runId,
      private: repo.private,
      ...pick.inputs,
      startedBy: null,
      triggeredBy: null,
      ...starters.get(jobKey(key)),
    };
    const answered = await this.pickMachine(job, rerun);
    // Every machine that fits is full: the re-run waits in line on its label, like a new pick.
    if (answered && typeof answered !== "string" && "full" in answered) {
      const waiting: WaitingJob = {
        id: routeId,
        queuedAt: Date.now(),
        repositoryId: queued.repositoryId,
        runId: queued.runId,
        jobId: queued.jobId,
        runAttempt,
        job,
      };
      await this.ctx.storage.put(WAIT_KEY + routeId, waiting);
      await this.wakeIn(WAIT_POLL_MS);
      return "waiting";
    }
    if (typeof answered !== "string") return null;
    return (await this.ctx.storage.get<Route>(ROUTE_KEY + routeId)) ?? null;
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

  /**
   * Stops a route holding its machine. MachineLink calls this when the machine reports in, and
   * gets back the job the route was claimed by.
   */
  async release(routeId: string): Promise<number | undefined> {
    const route = await this.ctx.storage.get<Route>(ROUTE_KEY + routeId);
    if (route && route.state !== "done")
      await this.ctx.storage.put(ROUTE_KEY + routeId, { ...route, state: "done" });
    // A job ending may free a slot for one that waits.
    if ((await this.ctx.storage.list({ prefix: WAIT_KEY, limit: 1 })).size > 0)
      await this.wakeIn(1_000);
    return route?.jobId;
  }

  /**
   * Wipes every route kept for the workspace. Operator deletes call this (src/admin-delete.ts):
   * expired routes are only dropped when the Router is called again, which a deleted workspace's
   * never is.
   */
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAll();
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

// Values read from GitHub, reused while younger than the age a caller accepts. Each is kept as a
// promise so callers that arrive together share one read, and a failed read is forgotten so the
// next caller asks again.
class Recent<K, V> {
  private entries = new Map<K, { at: number; value: Promise<V> }>();

  get(key: K, maxAge: number, read: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && now - cached.at < maxAge) return cached.value;
    const value = read();
    this.entries.set(key, { at: now, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  forget(key: K) {
    this.entries.delete(key);
  }
}

// The machines a live route still holds.
// Better Auth keeps a GitHub account's id as text.
function githubId(accountId: string | null): number | null {
  const id = Number(accountId);
  return accountId && Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Which machines a waiting job can use, as far as its line order goes: the same labels, repo and
// starters fit the same machines.
function wantsKey(job: PickedJob): string {
  return JSON.stringify([job.machine, job.repositoryId, job.startedBy?.id, job.triggeredBy?.id]);
}
