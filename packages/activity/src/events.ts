import { byRunnerKey, RUNNER_KEYS } from "@relayrunner/runner-order";
import { z } from "zod";

// The workspace's audit log: one append-only row per thing that happened, newest first on the
// Activity page. Each type's `data` is checked against its schema here when the API writes it, and
// the dashboard renders each type from the same definitions. Adding a type is a new entry in
// ActivityEvent (and how the page shows it), never a migration.

// The machine's name when the event happened, so the log still reads after a rename or a delete.
const machineData = { machineName: z.string() };

// Whose jobs a machine takes (#237): `only_me` runs only jobs its owner started (the run and this
// attempt), `anyone` runs any job from the workspace's private repos, bots included. A third value
// (people the owner picks, #245) comes later.
export const MACHINE_SHARING = ["only_me", "anyone"] as const;
export type MachineSharing = (typeof MACHINE_SHARING)[number];

export const DISCONNECT_REASONS = ["closed", "timeout", "revoked", "error"] as const;
export type DisconnectReason = (typeof DISCONNECT_REASONS)[number];

// Why a step of the runner order didn't take a job (the Router's decideRoute).
export const SKIP_REASONS = [
  // The relay left that provider's input empty.
  "not_configured",
  // Machines never run a public repo's jobs.
  "public_repo",
  // No online, idle machine had every wanted label.
  "no_machine",
  // Every machine with the wanted labels is paused (listed in the step's `paused`).
  "machine_paused",
  // Every online, unpaused machine with the wanted labels that takes the job has all its slots in
  // use (listed in `full`).
  "machine_full",
  // Machines with the wanted labels exist, but none takes this job's starter: each is `only_me`
  // and someone else (or a bot, or a schedule) started the run (listed in `notShared`).
  "machine_not_shared",
  // `github` or a hosted provider's input named more than one label.
  "too_many_labels",
  // A hosted provider's input named a label that isn't that provider's (such as `depot` naming
  // `ubuntu-latest`), so its runner would never start.
  "not_provider_label",
  // A GitHub step with a minutes limit: the job's account is at or past the limit's % of its
  // included quota (#117).
  "minutes_limit",
  // A GitHub step with a minutes limit: under the limit, but fewer quota minutes are left than
  // about two hours of the account's recent burn, which billing's lag could use up (#117).
  "minutes_runway",
  // A hosted provider's runner type that stopped picking up jobs: its last few jobs waited with no
  // runner, so the Router skips it until a trial job starts (src/provider-health.ts).
  "provider_unhealthy",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// A GitHub account's Actions minutes when a limited GitHub step looked at it.
export const MinutesUsage = z.object({
  account: z.string(),
  usedMinutes: z.number(),
  quotaMinutes: z.number(),
  // The step's limit, as a % of the quota.
  percent: z.number(),
  burnRatePerHour: z.number().nullable(),
});
export type MinutesUsage = z.infer<typeof MinutesUsage>;

/**
 * A GitHub account that started a run or an attempt: `id` is GitHub's account id, which is what
 * matches it to a workspace member (members sign in with GitHub); null when GitHub didn't say.
 * Bots (`dependabot[bot]`) and people outside the workspace keep their login and match no one.
 */
export const GithubActor = z.object({ id: z.number().nullable(), login: z.string() });
export type GithubActor = z.infer<typeof GithubActor>;

// A machine that fit a job's labels but only runs its owner's jobs.
export const NotSharedMachine = z.object({ machine: z.string(), owner: z.string().nullable() });
export type NotSharedMachine = z.infer<typeof NotSharedMachine>;

// A machine that fit a job but had no free slot: `running` of its `slots` were in use, counting
// jobs about to start on it.
export const FullMachine = z.object({
  machine: z.string(),
  running: z.number(),
  slots: z.number(),
});
export type FullMachine = z.infer<typeof FullMachine>;

const relayInputsShape = () => byRunnerKey(() => z.array(z.string()).default([]));

/**
 * How a pick walked the workspace's runner order. `step` is the provider that took the job (null
 * when nothing fit), `skipped` the earlier steps in order with why, and `notInOrder` the providers
 * the relay set that the order leaves out. The rest are the relay's inputs, one per provider; a
 * walk kept before a provider existed reads with no labels for it.
 */
export const RouteWalk = z.object({
  step: z.enum(RUNNER_KEYS).nullable(),
  skipped: z.array(
    z.object({
      key: z.enum(RUNNER_KEYS),
      // Walks kept before other hosted providers say not_blacksmith_label.
      reason: z.preprocess(
        (reason) => (reason === "not_blacksmith_label" ? "not_provider_label" : reason),
        z.enum(SKIP_REASONS),
      ),
      // machine_paused: the paused machines' names.
      paused: z.array(z.string()).optional(),
      // machine_not_shared: the machines that fit but only run their owner's jobs, with the
      // owner's name when known.
      notShared: z.array(NotSharedMachine).optional(),
      // machine_full: the machines that fit, each with its slots in use.
      full: z.array(FullMachine).optional(),
      // minutes_limit and minutes_runway: the job's GitHub account and its usage at the pick.
      minutes: MinutesUsage.optional(),
      // provider_unhealthy: how many jobs in a row weren't picked up, and when the next trial goes.
      unhealthy: z.object({ misses: z.number(), retryAt: z.number() }).optional(),
    }),
  ),
  notInOrder: z.array(z.enum(RUNNER_KEYS)),
  ...relayInputsShape(),
});
export type RouteWalk = z.infer<typeof RouteWalk>;

export const ActivityEvent = z.discriminatedUnion("type", [
  // A machine finished `relayrunner connect` enrollment and got its token. Actor: the user who
  // approved it.
  z.object({
    type: z.literal("machine.enrolled"),
    data: z.object({
      ...machineData,
      os: z.string().nullable(),
      arch: z.string().nullable(),
      // "github": a self-hosted runner added from GitHub (#159), not enrolled with the CLI.
      source: z.enum(["connect", "github"]).optional(),
    }),
  }),
  // The machine's CLI connected and said hello: it can take jobs.
  z.object({
    type: z.literal("machine.connected"),
    data: z.object({
      ...machineData,
      runnerVersion: z.string().nullable(),
      // Missing from events logged before the CLI reported its version.
      cliVersion: z.string().nullable().optional(),
    }),
  }),
  // The machine went offline: its CLI closed the connection (`closed`), it went quiet past the
  // heartbeat timeout (`timeout`, e.g. sleep or lost network), it was revoked (`revoked`), or it
  // broke the protocol (`error`). A newer connection replacing an older one logs nothing.
  z.object({
    type: z.literal("machine.disconnected"),
    data: z.object({ ...machineData, reason: z.enum(DISCONNECT_REASONS) }),
  }),
  // Someone paused the machine: it stays connected, but jobs skip it until it's resumed. Actor:
  // the user who paused it from the dashboard, or none when its own CLI did (`via`).
  z.object({
    type: z.literal("machine.paused"),
    data: z.object({ ...machineData, via: z.enum(["dashboard", "cli"]) }),
  }),
  // Someone resumed a paused machine, so jobs can route to it again. Actor as for machine.paused.
  z.object({
    type: z.literal("machine.resumed"),
    data: z.object({ ...machineData, via: z.enum(["dashboard", "cli"]) }),
  }),
  // The machine's owner changed whose jobs it takes. Actor: the owner.
  z.object({
    type: z.literal("machine.sharing_changed"),
    data: z.object({ ...machineData, sharing: z.enum(MACHINE_SHARING) }),
  }),
  // The machine's owner put it in this workspace, or took it out (#363): it takes jobs here, or
  // stops. Actor: the owner.
  z.object({ type: z.literal("machine.workspace_added"), data: z.object(machineData) }),
  z.object({ type: z.literal("machine.workspace_removed"), data: z.object(machineData) }),
  // Someone removed the machine from the workspace. Actor: that user.
  z.object({
    type: z.literal("machine.revoked"),
    data: z.object({ ...machineData, source: z.enum(["connect", "github"]).optional() }),
  }),
  // Someone left the workspace (`left`): their GitHub sign-in can no longer see its installation
  // (#317). Actor: them. Older rows may also be an owner or admin removing them (`left: false`).
  z.object({
    type: z.literal("member.removed"),
    data: z.object({ memberName: z.string(), left: z.boolean() }),
  }),
  // Someone joined: their GitHub sign-in can now see the workspace's installation (#317). Actor:
  // the new member.
  z.object({
    type: z.literal("member.joined"),
    data: z.object({ name: z.string(), email: z.string(), role: z.string() }),
  }),
  // RelayRunner routed a job (a job in a run with a `runs-on: relayrunner` pick). Its row shows the
  // job's live state, so there is one event per job, not one per status change.
  z.object({ type: z.literal("job.routed"), data: z.object({}) }),
  // A relay failed fast because nothing in the runner order could take its run, so the job that
  // needed it never started. `reason` is the message the relay failed with on GitHub. `walk` is
  // null when the pick stopped before the order (e.g. RelayRunner can't see the repo).
  z.object({
    type: z.literal("job.unroutable"),
    data: z.object({
      repository: z.string(),
      runId: z.number(),
      runAttempt: z.number(),
      workflow: z.string().nullable(),
      // The relay job's name, e.g. "relay".
      job: z.string().nullable(),
      reason: z.string(),
      walk: RouteWalk.nullable(),
      // Who started the run (github.actor) and this attempt (github.triggering_actor). Missing on
      // entries logged before #241.
      startedBy: GithubActor.nullable().optional(),
      triggeredBy: GithubActor.nullable().optional(),
    }),
  }),
  // GitHub billed Actions overage for a connected account this cycle: its usage went past the
  // included quota (#117). Logged once per account per billing cycle, by the billing poll.
  // `netAmount` is the USD billed so far when the poll first saw it.
  z.object({
    type: z.literal("minutes.overage"),
    data: z.object({
      account: z.string(),
      installationId: z.number(),
      cycleStart: z.string(),
      netAmount: z.number(),
    }),
  }),
  // A free check ran with no Actions runner, so it stands in for an Actions job that would have
  // billed a minute: the GitHub App's PR title check run (src/pr-title-check.ts), or one lint run
  // in the Checks App's container (src/durable-objects/lint-runner.ts), from a pull request push
  // or a native `checks/lint` job. `check` is "PR title" or "Lint"; `url` the check run's page on
  // GitHub, null for lint, which posts a run per tool. `pullRequest` is null for a lint run with no
  // pull request (a native job or a re-run), which then names its commit.
  z.object({
    type: z.literal("check.completed"),
    data: z.object({
      check: z.string(),
      repository: z.string(),
      repositoryId: z.number(),
      pullRequest: z.number().nullable(),
      headSha: z.string(),
      conclusion: z.enum(["success", "failure"]),
      url: z.string().nullable(),
    }),
  }),
]);

export type ActivityEvent = z.infer<typeof ActivityEvent>;
export type ActivityEventType = ActivityEvent["type"];

/** The Activity page's filters: the part of the type before the dot. */
export const ACTIVITY_FILTERS = ["job", "check", "machine", "member"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

/**
 * How a job or check ended, for the Activity page's result filter. `failed` takes in timed-out
 * jobs and runs that couldn't route; `running` is a job that hasn't finished.
 */
export const ACTIVITY_RESULTS = ["passed", "failed", "cancelled", "skipped", "running"] as const;
export type ActivityResult = (typeof ACTIVITY_RESULTS)[number];
