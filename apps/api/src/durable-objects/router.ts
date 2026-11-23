import { preferFirst, type RelayInputs, type RunnerKey } from "@relayrunner/runner-order";
import { Recent } from "../recent.ts";
import { accountUsage } from "../providers/actions-billing.ts";
import { accountSpend } from "../providers/provider-spend.ts";
import { resolveRunnerOrder } from "../routing/runner-orders.ts";
import { blacksmithMinutes, type BlacksmithMinutes } from "../providers/blacksmith-minutes.ts";
import { readBoatStarts, StartBudget } from "../providers/boat-limits.ts";
import {
  ACCOUNT_TTL_MS,
  groundboxHeld,
  groundboxMinutes,
  type GroundboxReading,
  readGroundboxAccount,
} from "../providers/groundbox-account.ts";
import { DurableObject } from "cloudflare:workers";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import type { QueueEntry } from "@relayrunner/machine-protocol";
import { GitHubRateLimitError } from "../github/github-api.ts";
import { appInstallationToken, orgAppSlugs } from "../github/github-app.ts";
import { userCanReadRepo } from "../github/repos-api.ts";
import { listRunners, type GitHubRunner, type RunnerScope } from "../github/runners-api.ts";
import { installationRunnerScope } from "../github/installations.ts";
import { inWorkspace } from "../machines/machines.ts";
import { runStartersForJobs } from "../ingest/job-starters.ts";
import { clearJobMachine, setJobMachine } from "../ingest/jobs.ts";
import { findRepo } from "../github/repositories.ts";
import { jobName } from "../reports/run-job.ts";
import {
  cleared,
  healthGate,
  healthId,
  updateHealth,
  type JobSignal,
  type LabelHealth,
} from "../routing/provider-health.ts";
import { earlierPick, jobKey } from "../routing/route-decisions.ts";
import type { RetryPick } from "../routing/retries.ts";
import {
  MAX_REQUEUES,
  NO_MACHINE_GIVE_UP_MS,
  type StrandedReason,
  strandedJobName,
} from "../routing/stranded-jobs.ts";
import { errorMessage } from "../errors.ts";
import { traced } from "../tracing.ts";
import { providersOfAppSlugs, type HostedProviderId } from "@relayrunner/providers";
import type { ProviderAccess } from "@relayrunner/activity";
import {
  APP_CHECKED,
  APPS_TTL_MS,
  missed,
  missGate,
  missId,
  type RepoMiss,
} from "../routing/provider-takeover.ts";
import {
  fetchGroupAccess,
  matchLabels,
  parseStoredLabels,
  runnerStatus,
  runnerListKey,
  scopeKey,
  type GroupAccess,
} from "../github/github-runners.ts";
import {
  admits,
  canClaim,
  chooseAndHold,
  chooseMachine,
  decideRoute,
  fits as fitsLabels,
  fullMachines,
  readyMachines,
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
} from "../routing/routing.ts";

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
  // startedBy, triggeredBy and runAttempt (JobStarters): who started the run and this attempt, and
  // which attempt it is. A machine that's `only_me` takes the job when its owner started the run:
  // on the first attempt, only when its owner started that attempt too (admits).
  // Set when this attempt is an automatic retry (src/routing/retries.ts): where the job failed and where
  // the retry should go.
  retry?: RetryPick | null;
  // An auto relay's size in vCPUs and the provider the Router page put first for the job
  // (src/routing/auto-jobs.ts).
  size?: number;
  first?: RunnerKey | null;
}

const ROUTE_KEY = "route:";
// Jobs waiting for a machine slot (Router.wait), by the route id their pick answered.
const WAIT_KEY = "wait:";
// Which waiting jobs each machine was last told wait on it (tellWaiting): the jobs, or a count
// from before the Router said which.
const WAITING_TOLD_KEY = "waiting-told";
interface WaitingTold {
  workspaceId: string;
  machines: Record<string, QueueEntry[] | number>;
}
// How often the Router looks for a free slot while jobs wait. A machine finishing a job also
// wakes it (release).
const WAIT_POLL_MS = 10_000;

interface WaitingJob extends Waiting {
  job: PickedJob;
  // How many times the job went back in line after a machine didn't start it (requeueSent).
  requeues?: number;
  // The machine it was last sent to, tried last.
  avoid?: string;
  // Since when no machine that could take it has been online (drain).
  noMachineSince?: number;
  // The job's name and workflow once its `queued` webhook said which job it is, for the queue its
  // machines show (tellWaiting).
  name?: string;
  workflow?: string;
}
// A route as the Router keeps it. A route to a connected machine keeps the job its pick was for,
// so the job can go back in line if it never starts on the machine (requeue, requeueSent).
interface StoredRoute extends Route {
  job?: PickedJob;
  requeues?: number;
}
// Each hosted provider runner type's health (src/routing/provider-health.ts), by healthId.
const HEALTH_KEY = "health:";
// Each hosted provider that missed a job of a repo (src/routing/provider-takeover.ts), by missId.
const MISS_KEY = "miss:";

// How long a GitHub org's runner group access is reused before it's read again. Groups change
// rarely and take a few calls to read.
const GROUP_ACCESS_TTL_MS = 5 * 60_000;
// How long a machine owner's read access to a repo is reused before GitHub is asked again.
const OWNER_ACCESS_TTL_MS = 10 * 60_000;
// How long a pick reuses an account's provider spend for spend limits.
const SPEND_TTL_MS = 60_000;
// How long the dashboard reuses an org's (or repo's) runner list (status, busy, labels).
const RUNNER_LIST_TTL_MS = 30_000;
// How old a runner list a pick accepts, so a push that starts many runs at once asks GitHub once
// rather than once per run. Short, since a runner's busy status decides whether it gets the job.
const PICK_RUNNER_LIST_TTL_MS = 5_000;
// How long the scan of an account's private repos for runners to add is reused. The Runners page
// and the Add runners dialog share it; the dialog's Rescan reads it fresh.
const FOUND_LIST_TTL_MS = 10 * 60_000;

/** A runner list as GitHub answered it, and when (epoch ms). */
export type RunnerList = { runners: GitHubRunner[]; checkedAt: number };

// One per workspace, addressed by workspace id. Decides where each picked job's run goes and
// keeps the routes it hands out (src/routing/routing.ts), so the job queued on a route's label can find
// its machine.
export class Router extends DurableObject<Env> {
  // What GitHub said, kept in memory while the object is awake: runner group access by
  // installation id, each org's or repo's runner list by `<installation>:<scope key>`, and whether
  // a machine owner can read a repo by `<installation>:<repo id>:<owner GitHub id>`. Also each
  // account's provider spend this month by `<installation>:<provider>`, so a burst of jobs doesn't
  // read D1 for every pick.
  private groupAccess = new Recent<number, Map<number, GroupAccess>>();
  private runnerLists = new Recent<string, RunnerList>();
  private ownerAccess = new Recent<string, boolean>();
  private spend = new Recent<string, { account: string; spentUsd: number }>();
  private freeMinutes = new Recent<string, BlacksmithMinutes>();
  // Boat's job starts left, from the workspace's Boat connection (src/providers/boat-limits.ts).
  private boatStarts = new StartBudget();
  // Groundbox's account (free minutes, holds), from the workspace's connection.
  private groundbox = new Recent<string, GroundboxReading>(1_000);
  // The hosted providers whose GitHub App is installed on an org, by installation id; null when
  // GitHub couldn't say.
  private providerApps = new Recent<number, HostedProviderId[] | null>(1_000);

  /**
   * An org's (or repo's) self-hosted runners for the dashboard's Runners and Router pages, reused
   * for RUNNER_LIST_TTL_MS so the pages' refreshes don't each ask GitHub, with when GitHub was
   * asked (epoch ms). Null when GitHub can't be asked.
   */
  async githubRunners(
    installationId: number,
    scope: RunnerScope,
    maxAge = RUNNER_LIST_TTL_MS,
  ): Promise<RunnerList | null> {
    try {
      return await this.checkedRunnerList(maxAge, installationId, scope);
    } catch (error) {
      console.warn(
        JSON.stringify({
          msg: "github runners unavailable",
          installationId,
          scope: scopeKey(scope),
          error: errorMessage(error),
        }),
      );
      return null;
    }
  }

  /**
   * The runner lists of several scopes, such as each of an account's private repos, for finding
   * runners to add. Reused for FOUND_LIST_TTL_MS unless `fresh`. Null for a list GitHub refused.
   */
  githubRunnerLists(installationId: number, scopes: RunnerScope[], { fresh = false } = {}) {
    const maxAge = fresh ? 0 : FOUND_LIST_TTL_MS;
    return Promise.all(
      scopes.map(async (scope) => {
        const list = await this.githubRunners(installationId, scope, maxAge);
        return list?.runners ?? null;
      }),
    );
  }

  // An org's or repo's runner list, no older than `maxAge`. The dashboard and picks share one copy.
  private checkedRunnerList(
    maxAge: number,
    installationId: number,
    scope: RunnerScope,
  ): Promise<RunnerList> {
    return this.runnerLists.get(runnerListKey(installationId, scope), maxAge, async () => ({
      runners: await listRunners(await appInstallationToken(this.env, installationId), scope),
      checkedAt: Date.now(),
    }));
  }

  private async runnerList(maxAge: number, installationId: number, scope: RunnerScope) {
    return (await this.checkedRunnerList(maxAge, installationId, scope)).runners;
  }

  /**
   * Whether a machine's owner can read the job's repo, as the job's installation sees it. Reused
   * for OWNER_ACCESS_TTL_MS. No owner, or GitHub can't be asked: no, and the machine sits this job
   * out (nothing is cached, so the next pick asks again). `rate_limited` when GitHub refused for
   * the installation's API limit, so the pick can say why.
   */
  private async ownerCanRead(
    machineId: string,
    ownerGithubId: number | null,
    job: PickedJob,
  ): Promise<boolean | "rate_limited"> {
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
            rateLimited: error instanceof GitHubRateLimitError,
            error: errorMessage(error),
          }),
        );
        if (error instanceof GitHubRateLimitError) return "rate_limited";
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
   * Where the run's next job goes, walking the repository's runner order (src/routing/runner-orders.ts): a machine route's
   * `rr-<id>`, the job's own `github` label, or no runner and the reason. A GitHub step with a
   * minutes limit passes the job on once the job's account nears its included quota.
   */
  async route(job: PickedJob): Promise<RouteDecision> {
    return traced(
      "router.route",
      {
        "relayrunner.workspace_id": job.workspaceId,
        "github.installation_id": job.installationId,
        "github.repository": job.repo,
        "github.run_id": job.runId,
        "relayrunner.retry": Boolean(job.retry),
      },
      async (span) => {
        const decision = await this.decide(job);
        span.setAttributes({
          "relayrunner.skipped": decision.skipped.length,
          "relayrunner.own_order": Boolean(decision.ownOrder),
          ...(decision.runner === null
            ? { "relayrunner.reason": decision.reason }
            : {
                "relayrunner.runner": decision.runner,
                "relayrunner.step": decision.step,
                "relayrunner.waited": Boolean(decision.waited),
              }),
        });
        return decision;
      },
    );
  }

  private async decide(job: PickedJob): Promise<RouteDecision> {
    const db = createDb(this.env.DB);
    // One Groundbox reading per workspace a minute; a failed read is tried again next job.
    const groundboxAccount = () =>
      this.groundbox.get(
        job.workspaceId,
        ACCOUNT_TTL_MS,
        () => readGroundboxAccount(this.env, db, job.workspaceId),
        (reading) => reading.ok || reading.reason !== "read_failed",
      );
    // The machine step's pick, if the walk got that far.
    let pick: MachinePick | undefined;
    const [[workspace], { order, scope }] = await Promise.all([
      db
        .select({
          skipUnhealthy: schema.workspace.skipUnhealthyRunners,
          accountType: schema.githubInstallation.accountType,
          accountLogin: schema.githubInstallation.accountLogin,
        })
        .from(schema.workspace)
        .leftJoin(
          schema.githubInstallation,
          eq(schema.githubInstallation.id, schema.workspace.installationId),
        )
        .where(eq(schema.workspace.id, job.workspaceId))
        .limit(1),
      resolveRunnerOrder(db, job.workspaceId, job.repositoryId),
      // Jobs already waiting get a free slot before this one can.
      this.drain(),
    ]);
    const walked = await decideRoute(
      retryOrder(preferFirst(order, job.first), job.retry),
      // Some hosted providers only serve organizations (SKIPS_PERSONAL_ACCOUNTS).
      { ...job, personal: workspace?.accountType === "User" },
      async () => (pick = await this.pickMachine(job)),
      // The job's own account: each GitHub account has its own quota, never pooled (#117).
      () => accountUsage(db, job.installationId),
      // Off: every hosted step takes its jobs, however they've been going.
      workspace?.skipUnhealthy === false
        ? undefined
        : (key, label) => this.checkHealth(healthId(key, label)),
      // Also per account: a provider bills each GitHub org on its own.
      // Spend only grows as jobs finish, and a limit is a soft cap, so a minute-old read will do.
      (key) =>
        this.spend.get(`${job.installationId}:${key}`, SPEND_TTL_MS, () =>
          accountSpend(db, job.installationId, key),
        ),
      // Blacksmith's count only changes when the hourly sync lands; Groundbox's is read live.
      async (key) =>
        key === "groundbox"
          ? groundboxMinutes(await groundboxAccount())
          : this.freeMinutes.get(job.workspaceId, SPEND_TTL_MS, () =>
              blacksmithMinutes(db, job.workspaceId),
            ),
      // Only Boat's plans cap job starts, and only its connection can say how many are left.
      async (key) =>
        key === "boat"
          ? this.boatStarts.check(() => readBoatStarts(this.env, db, job.workspaceId))
          : null,
      // Only Groundbox's connection says when it would hold a job.
      async (key) => (key === "groundbox" ? groundboxHeld(await groundboxAccount()) : null),
      (key) =>
        this.checkAccess(key, job, workspace?.accountType ?? null, workspace?.accountLogin ?? null),
    );
    const decision: RouteDecision = scope === "repository" ? { ...walked, ownOrder: true } : walked;
    if (decision.runner !== null && decision.step === "boat") this.boatStarts.took();
    if (waitsForMachine(decision)) return this.wait(job, decision);
    if (
      decision.runner !== null &&
      typeof pick === "object" &&
      pick &&
      "full" in pick &&
      pick.machineIds?.length
    )
      await this.tellSpilled(pick.machineIds);
    return decision;
  }

  // Tells each full machine a job that fit it went elsewhere, so its app can say so.
  private async tellSpilled(machineIds: string[]) {
    const at = Date.now();
    await Promise.all(
      machineIds.map(async (id) => {
        try {
          await this.env.MACHINE_LINK.getByName(id).spilled(at);
        } catch (error) {
          console.warn(
            JSON.stringify({
              msg: "relayrunner spillover not sent",
              machineId: id,
              error: errorMessage(error),
            }),
          );
        }
      }),
    );
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
    if (stored.size === 0) return this.tellWaiting(new Map());
    const line = waitingLine([...stored.values()], now);
    if (line.length < stored.size) {
      const live = new Set(line.map((entry) => WAIT_KEY + entry.id));
      const expired = [...stored.keys()].filter((key) => !live.has(key));
      // delete() takes at most 128 keys at a time.
      for (let i = 0; i < expired.length; i += 128)
        await this.ctx.storage.delete(expired.slice(i, i + 128));
    }
    // Per set of machines a job wants that took none: true when none of them is online (the job
    // ends after a while), false when they're only busy (it waits).
    const stuck = new Map<string, boolean>();
    // Per set of wanted machines that are all busy, their ids, and how many jobs wait on each.
    const busy = new Map<string, string[]>();
    const waitingOn = new Map<string, QueueEntry[]>();
    let left = 0;
    for (const entry of line) {
      const wants = wantsKey(entry.job);
      let none = stuck.get(wants);
      if (none === undefined) {
        const pick = await this.pickMachine(entry.job, undefined, entry);
        if (typeof pick === "string") {
          if (!(await this.handOff(entry))) left++;
          continue;
        }
        none = !(pick && ("full" in pick || "rateLimited" in pick));
        stuck.set(wants, none);
        if (pick && "full" in pick) busy.set(wants, pick.machineIds ?? []);
      }
      if (await this.noMachine(entry, none, now)) continue;
      left++;
      const queued: QueueEntry = {
        repo: entry.job.repo,
        since: entry.queuedAt,
        ...(entry.name ? { name: entry.name } : {}),
        ...(entry.workflow ? { workflow: entry.workflow } : {}),
      };
      for (const id of busy.get(wants) ?? [])
        waitingOn.set(id, [...(waitingOn.get(id) ?? []), queued]);
    }
    await this.tellWaiting(waitingOn, line[0]?.job.workspaceId);
    if (left > 0) await this.wakeIn(WAIT_POLL_MS);
  }

  // Sends a waiting job its machine took to that machine, once its `queued` webhook has said which
  // job it is (before that, the route waits for claim like any other). False when sending failed
  // or the machine went offline: the job goes back in line, in its old place.
  private async handOff(entry: WaitingJob): Promise<boolean> {
    const route = await this.ctx.storage.get<StoredRoute>(ROUTE_KEY + entry.id);
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
      if (result !== "offline") return true;
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "relayrunner waiting job not sent",
          routeId: route.id,
          machineId: route.machineId,
          error: errorMessage(error),
        }),
      );
    }
    await this.backInLine(route, entry);
    return false;
  }

  /**
   * Puts a claimed job back in line when its machine went offline before the job reached it
   * (MachineLink.run said "offline"), so it doesn't sit queued on a label nobody serves (#71). The
   * next machine with room takes it, or the same one once it reconnects; until then it waits like
   * a job for a full machine. The job keeps its place in line and its label.
   */
  async requeue(routeId: string): Promise<void> {
    const queued = await this.ctx.blockConcurrencyWhile(async () => {
      const route = await this.ctx.storage.get<StoredRoute>(ROUTE_KEY + routeId);
      if (!route?.job || route.jobId === undefined || route.state === "done") return false;
      await this.backInLine(route, waitingFrom(route, route.job));
      return true;
    });
    if (!queued) return;
    console.log(JSON.stringify({ msg: "relayrunner job back in line", routeId }));
    await this.drain();
  }

  /**
   * Puts a job back in line when it was sent to a machine but never started there: the machine
   * reported its runner failed, or went offline and its runner isn't connected to GitHub
   * (MachineLink). The machine's runner is already removed, so the next machine with room mints
   * another on the same label. The machine it was sent to goes last. After MAX_REQUEUES the job
   * ends instead (StrandedJob).
   */
  async requeueSent(routeId: string, jobId: number, machineId: string): Promise<void> {
    const moved = await this.ctx.blockConcurrencyWhile(async () => {
      const route = await this.ctx.storage.get<StoredRoute>(ROUTE_KEY + routeId);
      if (!route?.job || route.jobId !== jobId || route.machineId !== machineId) return null;
      const requeues = (route.requeues ?? 0) + 1;
      const entry: WaitingJob = { ...waitingFrom(route, route.job), requeues, avoid: machineId };
      if (requeues > MAX_REQUEUES) await this.ctx.storage.delete(ROUTE_KEY + route.id);
      else await this.backInLine(route, entry);
      return { entry, requeues };
    });
    if (!moved) return;
    await clearJobMachine(createDb(this.env.DB), jobId, machineId);
    console.log(
      JSON.stringify({
        msg: "relayrunner unstarted job back in line",
        routeId,
        machineId,
        requeues: moved.requeues,
      }),
    );
    if (moved.requeues > MAX_REQUEUES) await this.end(moved.entry, "runner_failed");
    else await this.drain();
  }

  // Notes how long a queued waiting job has had no machine online that could take it, and ends it
  // once that's NO_MACHINE_GIVE_UP_MS, so it doesn't sit queued for 24 hours. A job whose machines
  // are only busy keeps waiting. True when the job ended.
  private async noMachine(entry: WaitingJob, none: boolean, now: number): Promise<boolean> {
    if (entry.jobId === undefined) return false;
    if (!none) {
      if (entry.noMachineSince !== undefined)
        await this.ctx.storage.put(WAIT_KEY + entry.id, { ...entry, noMachineSince: undefined });
      return false;
    }
    if (entry.noMachineSince === undefined) {
      await this.ctx.storage.put(WAIT_KEY + entry.id, { ...entry, noMachineSince: now });
      return false;
    }
    if (now - entry.noMachineSince < NO_MACHINE_GIVE_UP_MS) return false;
    // Read again under the lock: a machine may have taken it meanwhile.
    const ended = await this.ctx.blockConcurrencyWhile(async () => {
      if (!(await this.ctx.storage.get(WAIT_KEY + entry.id))) return false;
      await this.ctx.storage.delete(WAIT_KEY + entry.id);
      return true;
    });
    if (ended) await this.end(entry, "no_machine");
    return ended;
  }

  // Ends a queued job no machine can take, with the reason, so its run finishes (StrandedJob logs
  // how it went).
  private async end(entry: WaitingJob, reason: StrandedReason) {
    await this.env.STRANDED_JOB.getByName(strandedJobName(entry.id, entry.jobId!)).start({
      routeId: entry.id,
      jobId: entry.jobId!,
      installationId: entry.job.installationId,
      repo: entry.job.repo,
      reason,
    });
  }

  // Ends a route whose job didn't reach its machine and puts the job back in line under the same
  // id, giving back the machine's slot.
  private async backInLine(route: StoredRoute, entry: WaitingJob) {
    await this.ctx.storage.delete(ROUTE_KEY + route.id);
    await this.ctx.storage.put(WAIT_KEY + route.id, { ...entry, jobId: route.jobId });
    await this.env.MACHINE_LINK.getByName(route.machineId).dropHold(route.id);
    await this.wakeIn(WAIT_POLL_MS);
  }

  // Tells each machine which of this workspace's jobs wait on it, when that changed since it was
  // last told, including machines no job waits on any more. `workspaceId` is unknown when no job
  // is left, and then comes from the last time.
  private async tellWaiting(waitingOn: Map<string, QueueEntry[]>, workspaceId?: string) {
    const told = await this.ctx.storage.get<WaitingTold>(WAITING_TOLD_KEY);
    const workspace = workspaceId ?? told?.workspaceId;
    const before = told?.machines ?? {};
    const ids = new Set([...Object.keys(before), ...waitingOn.keys()]);
    const said = (jobs: QueueEntry[] | number | undefined) =>
      jobs === undefined || (Array.isArray(jobs) && jobs.length === 0) ? "" : JSON.stringify(jobs);
    const changed = [...ids].filter((id) => said(waitingOn.get(id)) !== said(before[id]));
    if (!workspace || changed.length === 0) return;
    await Promise.all(
      changed.map(async (id) => {
        try {
          await this.env.MACHINE_LINK.getByName(id).setWaiting(workspace, waitingOn.get(id) ?? []);
        } catch (error) {
          console.warn(
            JSON.stringify({
              msg: "relayrunner waiting count not sent",
              machineId: id,
              error: errorMessage(error),
            }),
          );
        }
      }),
    );
    const next: WaitingTold = { workspaceId: workspace, machines: Object.fromEntries(waitingOn) };
    await this.ctx.storage.put(WAITING_TOLD_KEY, next);
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
    if (!waiting || !canClaim(waiting, job)) return;
    await this.ctx.storage.delete(WAIT_KEY + routeId);
    // Drain counts the jobs left, so the machines it waited on hear one fewer.
    await this.wakeIn(0);
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

  // Null when a hosted provider may take the repo's job, marking it as the repo's trial when it's
  // due one; else why it can't. The installed-apps check only covers orgs (GitHub lists an org's
  // installed Apps, not a personal account's) and the providers in APP_CHECKED. Unknown never
  // skips.
  private async checkAccess(
    key: HostedProviderId,
    job: PickedJob,
    accountType: string | null,
    accountLogin: string | null,
  ): Promise<ProviderAccess | null> {
    if (accountType === "Organization" && accountLogin && APP_CHECKED.includes(key)) {
      const installed = await this.providerApps.get(
        job.installationId,
        APPS_TTL_MS,
        async () => {
          try {
            const token = await appInstallationToken(this.env, job.installationId);
            return providersOfAppSlugs(await orgAppSlugs(token, accountLogin));
          } catch (error) {
            console.warn(
              JSON.stringify({
                msg: "provider apps unavailable",
                installationId: job.installationId,
                error: errorMessage(error),
              }),
            );
            return null;
          }
        },
        (apps) => apps !== null,
      );
      if (installed && !installed.includes(key)) return { cause: "not_installed" };
    }
    const id = MISS_KEY + missId(key, job.repositoryId);
    const state = await this.ctx.storage.get<RepoMiss>(id);
    const now = Date.now();
    const gate = missGate(state, now);
    if (gate === "ok") return null;
    if (gate === "trial") {
      await this.ctx.storage.put(id, { ...state, trialAt: now });
      console.log(JSON.stringify({ msg: "provider repo trial", id }));
      return null;
    }
    return gate;
  }

  /** A job of the repo waited on the provider with no runner and was taken over. */
  async providerMissed(key: HostedProviderId, repositoryId: number): Promise<void> {
    const id = MISS_KEY + missId(key, repositoryId);
    const state = missed(await this.ctx.storage.get<RepoMiss>(id), Date.now());
    await this.ctx.storage.put(id, state);
    console.log(JSON.stringify({ msg: "provider missed repo", id, retryAt: state.retryAt }));
  }

  /** A runner picked up a job of the repo on the provider: it can see the repo again. */
  async providerPicked(key: HostedProviderId, repositoryId: number): Promise<void> {
    const id = MISS_KEY + missId(key, repositoryId);
    if (await this.ctx.storage.delete(id))
      console.log(JSON.stringify({ msg: "provider recovered for repo", id }));
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
        githubRepositoryId: schema.machine.githubRepositoryId,
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
    // installation never fits this job, and a repo runner only serves its own repo. An owner
    // with two GitHub accounts linked would list a machine twice: keep its first row.
    const seen = new Set<string>();
    // A re-run or a waiting job keeps its `rr-<id>` label, which only a connected machine's minted
    // runner carries.
    const fits = machines
      .filter((machine) => !seen.has(machine.id) && Boolean(seen.add(machine.id)))
      .filter(
        (machine) =>
          machine.source !== "github" ||
          (!rerun &&
            !waiting &&
            machine.installationId === job.installationId &&
            (machine.githubRepositoryId === null ||
              machine.githubRepositoryId === job.repositoryId)),
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
    // A runner added from GitHub is the org's own, already limited by its runner group. Only
    // machines with the job's labels are asked about, since no other could take it anyway.
    const readable = await Promise.all(
      admitted.map((machine) => {
        const entry = pool.find((e) => e.id === machine.id)!;
        if (machine.source === "github" || !needsOwnerAccess(entry, job)) return true;
        if (!fitsLabels(entry, job.machine)) return false;
        return this.ownerCanRead(machine.id, entry.ownerGithubId ?? null, job);
      }),
    );
    const live = admitted.filter((_, index) => readable[index] === true);
    const added = live.filter((machine) => machine.source === "github");
    const [orgRunners, repoRunners] = await Promise.all([
      added.some((machine) => machine.githubRepositoryId === null) ? this.orgRunners(job) : null,
      added.some((machine) => machine.githubRepositoryId !== null) ? this.repoRunners(job) : null,
    ]);
    const runners = orgRunners === "rate_limited" ? null : orgRunners;
    const repoList = repoRunners === "rate_limited" ? null : repoRunners;
    // GitHub's API limit kept a machine out of this pick: when nothing else takes the job, the
    // pick says so instead of reporting no idle machine.
    const rateLimited =
      orgRunners === "rate_limited" ||
      repoRunners === "rate_limited" ||
      readable.includes("rate_limited");
    const candidates: Candidate[] = await Promise.all(
      live.map(async (machine): Promise<Candidate> => {
        const { ownerName: _, ...base } = pool.find((entry) => entry.id === machine.id)!;
        if (machine.source !== "github")
          return { ...base, ...(await this.env.MACHINE_LINK.getByName(machine.id).status()) };
        // A repo runner has no runner group: it takes its own repo's jobs, which fits checked.
        const runner = (machine.githubRepositoryId === null ? runners?.runners : repoList)?.find(
          (r) => r.id === machine.githubRunnerId,
        );
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
    const reserved = await this.reserve(job, candidates, routingLabels, places, rerun, waiting);
    if (reserved) return reserved;
    if (rateLimited) return { rateLimited: true };
    // A re-run whose machines are offline or paused could still be taken once one is back, so it
    // waits in line (Router.reroute) instead of being refused like a re-run nothing fits.
    if (rerun && pool.some((machine) => fitsLabels(machine, job.machine) && admits(machine, job)))
      return { offline: true };
    return unavailableMachines(pool, job.machine, job);
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
        ? await this.ctx.storage.get<WaitingJob>(WAIT_KEY + waiting.id)
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
      const avoid = waitingNow?.avoid ?? (job.retry?.runner === "other" ? failedOn : undefined);
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
        if (!full) return null;
        const machineIds = readyMachines(candidates, job.machine, job).map((m) => m.id);
        return { full, machineIds };
      }
      const routingLabel = routingLabels.get(machine.id);
      const isolated = runsIsolated(machine, job.machine, job.github);
      const os = places.get(machine.id)?.[isolated ? "vm" : "host"];
      const route: StoredRoute = {
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
        ...(routingLabel ? { routingLabel } : { job }),
        ...(waitingNow?.requeues && { requeues: waitingNow.requeues }),
        ...(os ? { os } : {}),
        ...(isolated ? { isolated: true } : {}),
      };
      await this.ctx.storage.put(ROUTE_KEY + route.id, route);
      if (waiting) await this.ctx.storage.delete(WAIT_KEY + waiting.id);
      return routingLabel ?? routeLabel(route.id);
    });
  }

  // The job's org's self-hosted runners, read within the last few seconds, with their group access
  // (cached), or null when GitHub can't be reached (`rate_limited` when it refused for the API
  // limit): added runners then sit this pick out. A personal account has none.
  private async orgRunners(
    job: PickedJob,
  ): Promise<
    { runners: GitHubRunner[]; access: Map<number, GroupAccess> } | null | "rate_limited"
  > {
    const org = job.repo.split("/")[0];
    try {
      // A personal account has no org runners, only repo runners (repoRunners).
      const scope = await installationRunnerScope(
        createDb(this.env.DB),
        job.installationId,
        job.repo,
      );
      if (scope.kind === "repo") return { runners: [], access: new Map() };
      const runners = await this.runnerList(PICK_RUNNER_LIST_TTL_MS, job.installationId, {
        kind: "org",
        org,
      });
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
      return runnersUnavailable(job, error);
    }
  }

  // The runners registered on the job's own repo, read within the last few seconds, or as
  // orgRunners when GitHub can't be reached.
  private async repoRunners(job: PickedJob): Promise<GitHubRunner[] | null | "rate_limited"> {
    try {
      return await this.runnerList(PICK_RUNNER_LIST_TTL_MS, job.installationId, {
        kind: "repo",
        repo: job.repo,
      });
    } catch (error) {
      return runnersUnavailable(job, error);
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
    // Outside the lock: the name only labels the job in its machines' queue.
    const named = await jobName(createDb(this.env.DB), job.jobId).catch(() => undefined);
    return this.ctx.blockConcurrencyWhile(async () => {
      const waiting = await this.ctx.storage.get<WaitingJob>(WAIT_KEY + routeId);
      if (!waiting) return undefined;
      if (!canClaim(waiting, job)) return null;
      await this.ctx.storage.put(WAIT_KEY + routeId, { ...waiting, ...named, jobId: job.jobId });
      return "waiting" as const;
    });
  }

  /**
   * Routes a re-run job again on its old `rr-<id>` label. "Re-run failed jobs" doesn't re-run the
   * relay, so the job comes back on the label the earlier attempt's pick answered, whose route is
   * done or expired. When that pick was this run's (earlierPick), the route is made again under the
   * same id for this job, with that pick's inputs and this attempt's starters: the machine it ran
   * on if that one is free, else any machine the relay's labels and sharing allow. Returns the
   * claimed route, "waiting" when every machine that fits is full, offline or paused (it waits in
   * line like a new pick, and drain ends it if none comes back), or null when the label wasn't this
   * run's pick, no machine's labels and sharing allow the job, or another job of this attempt
   * already did.
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
    // Sharing only needs who started the run, which the pick knows: `only_me` takes any re-run of
    // its owner's run, whoever re-ran it (admits). Who re-ran it is known only once this attempt's
    // workflow_run arrives, which can come after the `queued` webhook; until then it's null.
    const starters = await runStartersForJobs(db, [key], new Map([[jobKey(key), pick]]), jobKey);
    const job: PickedJob = {
      workspaceId: queued.workspaceId,
      installationId,
      repositoryId: repo.id,
      repo: fullName,
      runId: queued.runId,
      private: repo.private,
      ...pick.inputs,
      startedBy: pick.startedBy,
      triggeredBy: starters.get(jobKey(key))?.triggeredBy ?? null,
      runAttempt,
    };
    const answered = await this.pickMachine(job, rerun);
    // Every machine that fits is full, or offline or paused (one may be back soon: a deploy drops
    // every machine's socket for a moment): the re-run waits in line on its label, like a new
    // pick. drain ends it once no machine that fits has been online for NO_MACHINE_GIVE_UP_MS.
    if (
      answered &&
      typeof answered !== "string" &&
      ("full" in answered || "offline" in answered || "rateLimited" in answered)
    ) {
      const waiting: WaitingJob = {
        id: routeId,
        queuedAt: Date.now(),
        repositoryId: queued.repositoryId,
        runId: queued.runId,
        jobId: queued.jobId,
        runAttempt,
        job,
      };
      // Checked again under the lock: another job of this attempt may have taken the route since.
      const queuedNow = await this.ctx.blockConcurrencyWhile(async () => {
        const now = Date.now();
        const prior = (await this.routes(now)).find((route) => route.id === routeId);
        if (!mayReroute(prior, rerun)) return false;
        await this.ctx.storage.put(WAIT_KEY + routeId, waiting);
        return true;
      });
      if (!queuedNow) return null;
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
   * Whether the Router still has `job` in hand on its `rr-<routeId>` label, for the orphaned job
   * sweep (src/routing/orphaned-jobs.ts): it waits in line for a machine slot (full machines are not stuck),
   * or a live route was claimed by it or can still be. Reads storage only.
   */
  async holds(routeId: string, job: QueuedJob): Promise<boolean> {
    const now = Date.now();
    const [waiting, route] = await Promise.all([
      this.ctx.storage.get<WaitingJob>(WAIT_KEY + routeId),
      this.ctx.storage.get<Route>(ROUTE_KEY + routeId),
    ]);
    if (waiting && now - waiting.queuedAt <= ROUTE_TTL_MS && canClaim(waiting, job)) return true;
    return (
      !!route &&
      route.state !== "done" &&
      now - route.createdAt <= ROUTE_TTL_MS &&
      canClaim(route, job)
    );
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
   * Wipes every route kept for the workspace. Operator deletes call this (src/operator/admin-delete.ts):
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

// Logs a failed runner list read for a pick: `rate_limited` when GitHub refused for the API limit.
function runnersUnavailable(job: PickedJob, error: unknown) {
  console.warn(
    JSON.stringify({
      msg: "github runners unavailable",
      installationId: job.installationId,
      repo: job.repo,
      rateLimited: error instanceof GitHubRateLimitError,
      error: errorMessage(error),
    }),
  );
  return error instanceof GitHubRateLimitError ? ("rate_limited" as const) : null;
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

// A route's job as a waiting entry, keeping its place in line and how often it was requeued.
function waitingFrom(route: StoredRoute, job: PickedJob): WaitingJob {
  return {
    id: route.id,
    queuedAt: route.createdAt,
    repositoryId: route.repositoryId,
    runId: route.runId,
    ...(route.jobId !== undefined && { jobId: route.jobId }),
    ...(route.runAttempt !== undefined && { runAttempt: route.runAttempt }),
    job,
    ...(route.requeues && { requeues: route.requeues }),
  };
}
