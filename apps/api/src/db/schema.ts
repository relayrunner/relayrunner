// Better Auth's tables in the shape its Drizzle adapter expects: the core four (user, session,
// account, verification), then the organization plugin's, renamed to workspaces (see auth.ts).
// Gateway tables (installations and their repos, then machines and routes) follow. After changing anything
// here, run `pnpm db:generate` to write a new migration.
import type { MachineSharing } from "@relayrunner/activity";
import type { HostedProviderId } from "@relayrunner/providers";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
};

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  // Global role, separate from per-workspace member roles. "operator" sees the dashboard's Admin
  // section. Null for everyone else. Granted by SQL for now (docs/cloudflare-access.md).
  role: text("role"),
  // When their workspace memberships were last read from GitHub (src/memberships.ts), so the
  // dashboard's workspace list only asks GitHub every few minutes.
  installationsSyncedAt: integer("installations_synced_at", { mode: "timestamp_ms" }),
  ...timestamps,
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // The workspace the dashboard is looking at. Set by the organization plugin.
    activeWorkspaceId: text("active_workspace_id"),
    ...timestamps,
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    // Sign-in finds the account by its GitHub id.
    index("account_provider_account_idx").on(table.providerId, table.accountId),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// A workspace is Better Auth's organization. It is created by a user (who becomes its owner), not
// mirrored from GitHub: it connects many GitHub App installations and owns the machine fleet.
// A workspace is one GitHub App installation (#315): installing the App on an account or org makes
// its workspace, and uninstalling deletes it with everything under it. Name, slug and logo follow
// the account's login and avatar (src/installations.ts ensureWorkspace). Users can't create one.
export const workspace = sqliteTable("workspace", {
  id: text("id").primaryKey(),
  installationId: integer("installation_id")
    .notNull()
    .unique()
    .references((): AnySQLiteColumn => githubInstallation.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  // JSON RunnerOrder (@relayrunner/runner-order). Null means the default order.
  runnerOrder: text("runner_order"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Who can see a workspace, synced from the installations their GitHub sign-in can see (#317).
export const workspaceMember = sqliteTable(
  "workspace_member",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("workspace_member_workspace_user_unique").on(table.workspaceId, table.userId),
    index("workspace_member_user_idx").on(table.userId),
  ],
);

// Better Auth's organization plugin insists on an invitation table, so it stays, but nothing
// writes it: membership comes from GitHub (#317) and the invite endpoints are off (auth.ts).
export const workspaceInvitation = sqliteTable(
  "workspace_invitation",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("workspace_invitation_workspace_idx").on(table.workspaceId),
    index("workspace_invitation_email_idx").on(table.email),
  ],
);

// A GitHub App installation (an org or a personal account). The installation id is the primary
// key, and its workspace points back here (workspace.installation_id), one each. Rows are written
// by the Setup URL callback and by installation webhooks (src/installations.ts); deleting one
// deletes its workspace.
export const githubInstallation = sqliteTable("github_installation", {
  id: integer("id").primaryKey({ autoIncrement: false }),
  accountId: integer("account_id").notNull(),
  accountLogin: text("account_login").notNull(),
  // 'Organization' or 'User', as GitHub reports it.
  accountType: text("account_type").notNull(),
  // 'all' or 'selected': whether the App sees every repo in the account or a chosen list.
  repositorySelection: text("repository_selection").notNull().default("all"),
  suspendedAt: integer("suspended_at", { mode: "timestamp_ms" }),
  // When GitHub's view in this row was observed (a webhook's receivedAt, or a GET
  // /user/installations read). The queue is unordered and retries, so an older observation
  // never overwrites a newer one.
  githubStateAt: integer("github_state_at", { mode: "timestamp_ms" }),
  // The GitHub user id of whoever installed the App (the `installation.created` webhook's sender).
  // They're the workspace's owner (src/memberships.ts). Null for installs from before #317.
  installerGithubId: integer("installer_github_id"),
  ...timestamps,
});

// A repository an installation can see, mirrored from GitHub so activity can name its repo and
// tell public from private. RelayRunner doesn't manage repos and there is no opt-in: a job that
// asks for `runs-on: relayrunner` from a connected installation is the opt-in. Rows are written by
// webhooks (src/repositories.ts) and go away with their installation.
export const githubRepository = sqliteTable(
  "github_repository",
  {
    // GitHub's repository id, stable across renames and transfers.
    id: integer("id").primaryKey({ autoIncrement: false }),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    // owner/name, as of the latest event.
    fullName: text("full_name").notNull(),
    private: integer("private", { mode: "boolean" }).notNull(),
    // Set when the installation lost access (repo removed from the selection, deleted, or
    // transferred away). Kept as a tombstone rather than deleted, so a retried "added" that lands
    // after a newer "removed" can't bring the repo back. See githubStateAt.
    removedAt: integer("removed_at", { mode: "timestamp_ms" }),
    // When the event behind this row's state was received. Older events never overwrite newer ones.
    githubStateAt: integer("github_state_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [index("github_repository_installation_idx").on(table.installationId)],
);

// Better Auth's device authorization plugin: one row per `relayrunner connect` sign-in in flight.
// The CLI polls with device_code while the user approves user_code in the dashboard. The plugin
// deletes the row once the CLI redeems it.
export const deviceCode = sqliteTable("device_code", {
  id: text("id").primaryKey(),
  deviceCode: text("device_code").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  // Set when a signed-in user opens the approval page; only that user can approve or deny.
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  // 'pending', 'approved' or 'denied'.
  status: text("status").notNull(),
  lastPolledAt: integer("last_polled_at", { mode: "timestamp_ms" }),
  pollingInterval: integer("polling_interval"),
  clientId: text("client_id"),
  scope: text("scope"),
  // Where the CLI asked for the code from (src/device-origin.ts), so the approval page can show it
  // and warn when it's far from whoever approves. Null when the request didn't say.
  requestIp: text("request_ip"),
  requestCountry: text("request_country"),
  requestCity: text("request_city"),
  ...timestamps,
});

// A machine RelayRunner can route jobs to. Two sources:
// - 'connect': enrolled with `relayrunner connect`; it authenticates with its own token, not a
//   user session, and runs one-job JIT runners the gateway mints. It belongs to its user (user_id),
//   not to a workspace (#318): it takes jobs in the workspaces its owner picked (machine_workspace,
//   #363). workspace_id is null.
// - 'github': a self-hosted runner its owner already registered in a connected org (#159).
//   RelayRunner never talks to the machine: it reads the runner's status from GitHub and steers
//   jobs to it with routing_label, a label it added to the runner on GitHub. token_hash and
//   enrollment_hash stay null. It is the org's, so it belongs to its installation's one workspace
//   (workspace_id) and goes with it; user_id is null.
//
// For 'connect' machines: Enrollment runs in two steps (src/machines.ts):
// approving the device code in the dashboard creates the row with enrollment_hash set, and the
// CLI's claim fills in os/arch and token_hash and clears enrollment_hash. Revoking keeps the row
// so past routes can still name the machine. Pausing (paused_at) keeps it out of routing only.
export const machine = sqliteTable(
  "machine",
  {
    id: text("id").primaryKey(),
    // 'github' only: the workspace of the installation the runner is registered in.
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    // 'connect' only (always set there): the user who enrolled it and owns it. Only they pause,
    // rename, share or revoke it. Deleting the user deletes their machines.
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The protocol's values (linux, macos, windows; x64, arm64, arm). Null until claimed.
    os: text("os"),
    arch: text("arch"),
    // SHA-256 (hex) of the machine token. The token itself is only ever shown to the CLI.
    tokenHash: text("token_hash").unique(),
    // SHA-256 (hex) of the token the gateway sent to replace it on the machine's last connect,
    // until the CLI says it saved it (src/durable-objects/machine-link.ts). Both work meanwhile.
    pendingTokenHash: text("pending_token_hash").unique(),
    // SHA-256 (hex) of the device code that approved this machine, while the claim is pending.
    enrollmentHash: text("enrollment_hash").unique(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    // Set while the machine is paused: it stays connected and enrolled, but routing skips it.
    // pausedBy is the user who paused it, or null when the machine paused itself from its CLI.
    pausedAt: integer("paused_at", { mode: "timestamp_ms" }),
    pausedBy: text("paused_by").references(() => user.id, { onDelete: "set null" }),
    // 'connect' or 'github' (above).
    source: text("source").notNull().default("connect"),
    // Whose jobs it takes (MACHINE_SHARING, #237): 'only_me' (only jobs its owner, userId,
    // started) or 'anyone'. One setting for every workspace the machine is in. Only the owner
    // changes it. Connected machines start as 'only_me';
    // runners added from GitHub are the org's shared runners and start as 'anyone'.
    sharing: text("sharing").$type<MachineSharing>().notNull().default("only_me"),
    // 'github' only: the installation whose org the runner is registered in, GitHub's runner id,
    // the label RelayRunner added to it (`rr-runner-<hex>`), and the runner's labels as last read
    // from GitHub (JSON array), for when GitHub can't be reached.
    installationId: integer("installation_id").references(() => githubInstallation.id, {
      onDelete: "set null",
    }),
    githubRunnerId: integer("github_runner_id"),
    routingLabel: text("routing_label").unique(),
    githubLabels: text("github_labels"),
    // 'connect' only: the device the CLI reported on its last hello (#165). Each part is its own
    // typed column, never a display string, so routing could match on specs later. Null when the
    // CLI didn't report it (older CLIs) or couldn't read it.
    // laptop, desktop, server, vm or unknown.
    deviceKind: text("device_kind"),
    // A display name ("MacBook Pro") and the raw identifier it came from ("Mac15,9").
    deviceModel: text("device_model"),
    deviceModelId: text("device_model_id"),
    chip: text("chip"),
    cpuCores: integer("cpu_cores"),
    memoryMb: integer("memory_mb"),
    osVersion: text("os_version"),
    deviceReportedAt: integer("device_reported_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    index("machine_workspace_idx").on(table.workspaceId),
    index("machine_user_idx").on(table.userId),
    index("machine_github_runner_idx").on(table.installationId, table.githubRunnerId),
  ],
);

// Which workspaces a connected machine takes jobs in (#363). Its owner picks them on /device, from
// the Runners page and with `relayrunner workspaces`. A row only counts while the owner is still a
// member there (src/machines.ts inWorkspace), and membership sync deletes the rows for a workspace
// the owner leaves. Adopted GitHub runners don't use this: they have machine.workspace_id.
export const machineWorkspace = sqliteTable(
  "machine_workspace",
  {
    machineId: text("machine_id")
      .notNull()
      .references(() => machine.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.machineId, table.workspaceId] }),
    index("machine_workspace_workspace_idx").on(table.workspaceId),
  ],
);

// A GitHub Actions job in a run that RelayRunner routed, for the dashboard's Activity page. A run
// is ours once its `runs-on: relayrunner` pick job arrives (kind 'pick'). Every other job in that
// run is stored too (kind 'job'): those are the real work, and GitHub has already resolved their
// `runs-on` to the pick's answer, so `labels` is the runner RelayRunner selected. Jobs from runs
// with no pick are never stored. Rows are written by workflow_job webhooks (src/jobs.ts) and go
// away with their installation.
export const workflowJob = sqliteTable(
  "workflow_job",
  {
    // GitHub's job id. A re-run gets new job ids under the same run id.
    id: integer("id").primaryKey({ autoIncrement: false }),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    repositoryId: integer("repository_id").notNull(),
    // owner/name when the job was last seen.
    repositoryFullName: text("repository_full_name").notNull(),
    runId: integer("run_id").notNull(),
    runAttempt: integer("run_attempt").notNull(),
    // 'pick' (asked for the relayrunner label) or 'job' (another job in a pick's run).
    kind: text("kind", { enum: ["pick", "job"] }).notNull(),
    workflowName: text("workflow_name"),
    name: text("name").notNull(),
    // The job's runs-on labels, as a JSON array. For a 'job' row this is the selected runner.
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull(),
    headBranch: text("head_branch"),
    headSha: text("head_sha").notNull(),
    // 'queued', 'in_progress' or 'completed' (GitHub also sends 'waiting'). Only moves forward:
    // the queue is unordered, so a late `queued` never rewinds a finished job.
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    // The runner that took the job, once one has.
    runnerName: text("runner_name"),
    // The machine a route sent this job to, set when the job's `queued` webhook claims its
    // `rr-<route id>` label. Null for jobs that ran on a GitHub label, and once the machine is
    // deleted.
    machineId: text("machine_id").references(() => machine.id, { onDelete: "set null" }),
    githubCreatedAt: integer("github_created_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    index("workflow_job_installation_idx").on(table.installationId, table.id),
    index("workflow_job_run_idx").on(table.runId, table.kind),
    // The pick sweep's recent picks (src/pick-sweep.ts).
    index("workflow_job_kind_created_idx").on(table.kind, table.githubCreatedAt),
    // The jobs each machine is running, and clearing machine_id when a machine is deleted.
    index("workflow_job_machine_idx")
      .on(table.machineId, table.status)
      .where(sql`${table.machineId} is not null`),
  ],
);

// Every job in a connected repo, whatever runner took it (src/job-timings.ts). While a job is
// queued or running (completed_at null) the Runs page shows it live; once it finishes the usage
// report counts it: how many jobs finished in under a minute and what GitHub's round-up to whole
// minutes cost. Unlike workflow_job, this keeps jobs RelayRunner never saw a pick for. Written by
// each of the job's webhooks, rolled up into job_timing_daily by the hourly cron once its day is
// past the raw retention window (dropped 7 days after it was first seen if it never finished), and
// gone with the installation.
export const jobTiming = sqliteTable(
  "job_timing",
  {
    // GitHub's job id.
    id: integer("id").primaryKey({ autoIncrement: false }),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    repositoryId: integer("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    runId: integer("run_id").notNull(),
    runAttempt: integer("run_attempt").notNull(),
    workflowName: text("workflow_name"),
    name: text("name").notNull(),
    // The job's runs-on labels, as a JSON array.
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull(),
    conclusion: text("conclusion"),
    runnerName: text("runner_name"),
    // With labels, decides the job's GitHub rate when the report is read (runnerClass).
    runnerGroupName: text("runner_group_name"),
    // The machine a route sent the job to, set with workflow_job's by setJobMachine (src/jobs.ts),
    // since the job's `rr-<route id>` label stops naming a machine once the route goes. Job times
    // (src/job-times.ts) report it as its own environment.
    machineId: text("machine_id"),
    // When GitHub queued the job, for the wait before a runner took it.
    queuedAt: integer("queued_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    // The usage report and job times: one workspace's installations over a time range.
    index("job_timing_installation_idx").on(table.installationId, table.completedAt),
    // Each machine's recent jobs, for its card on the Runners page. Partial: most jobs never ran
    // on a machine.
    index("job_timing_machine_idx")
      .on(table.machineId, table.completedAt)
      .where(sql`${table.machineId} is not null`),
    // One job's recent runs, for the job times detail.
    index("job_timing_job_idx").on(
      table.repositoryId,
      table.workflowName,
      table.name,
      table.completedAt,
    ),
    // The retention purge, across all installations.
    index("job_timing_completed_idx").on(table.completedAt),
    // The purge of jobs GitHub never said finished. Partial: almost every row has finished.
    index("job_timing_unfinished_idx")
      .on(table.createdAt)
      .where(sql`${table.completedAt} is null`),
    // One run's jobs, for its row on the Runs page.
    index("job_timing_run_idx").on(table.runId, table.runAttempt),
  ],
);

// Finished jobs past job_timing's raw retention, summed per UTC day and per the columns the usage
// report groups by (src/job-timings.ts), so its 90-day range costs a row per day and runner kind
// rather than a row per job. The hourly cron moves each day out of job_timing in one transaction,
// so a job is counted in one table or the other, never both. Purged once past the report's range.
export const jobTimingDaily = sqliteTable(
  "job_timing_daily",
  {
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    // The UTC midnight starting the day the jobs finished on.
    day: integer("day", { mode: "timestamp_ms" }).notNull(),
    repositoryId: integer("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull(),
    // Empty for none, so the key's columns are never null.
    runnerGroupName: text("runner_group_name").notNull().default(""),
    jobs: integer("jobs").notNull(),
    shortJobs: integer("short_jobs").notNull(),
    runMs: integer("run_ms").notNull(),
    billedMinutes: integer("billed_minutes").notNull(),
    shortBilledMinutes: integer("short_billed_minutes").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.installationId,
        table.day,
        table.repositoryId,
        table.labels,
        table.runnerGroupName,
      ],
    }),
    // The retention purge, across all installations.
    index("job_timing_daily_day_idx").on(table.day),
  ],
);

// One attempt of a GitHub Actions workflow run in a connected repo, from workflow_run webhooks
// (src/runs.ts), for the Runs page: what started it and how it ended. Its jobs' times come from
// job_timing. Purged with job_timing, and goes away with its installation.
export const workflowRun = sqliteTable(
  "workflow_run",
  {
    // GitHub's run id. Every attempt of a run shares it.
    id: integer("id").notNull(),
    runAttempt: integer("run_attempt").notNull(),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    repositoryId: integer("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    workflowName: text("workflow_name"),
    // The commit or PR title GitHub shows for the run.
    displayTitle: text("display_title"),
    // What triggered it: push, pull_request, schedule, workflow_dispatch, ...
    event: text("event").notNull(),
    actorLogin: text("actor_login"),
    // Who started the run (github.actor) and this attempt (github.triggering_actor), by GitHub
    // account id and login (#241). The id matches a member's GitHub sign-in. Null before #241.
    startedById: integer("started_by_id"),
    startedByLogin: text("started_by_login"),
    triggeredById: integer("triggered_by_id"),
    triggeredByLogin: text("triggered_by_login"),
    headBranch: text("head_branch"),
    headSha: text("head_sha").notNull(),
    pullRequestNumber: integer("pull_request_number"),
    // 'requested', 'queued', 'in_progress' or 'completed'.
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    htmlUrl: text("html_url"),
    runStartedAt: integer("run_started_at", { mode: "timestamp_ms" }),
    // The run's updated_at on GitHub. Deliveries are unordered, so a row only takes a newer one.
    githubUpdatedAt: integer("github_updated_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.id, table.runAttempt] }),
    // The Runs page: one workspace's installations over a time range.
    index("workflow_run_installation_idx").on(table.installationId, table.githubUpdatedAt),
    // The retention purge, across all installations.
    index("workflow_run_updated_idx").on(table.githubUpdatedAt),
  ],
);

// The workspace's audit log for the Activity page: one append-only row per event, typed by
// @relayrunner/activity (src/activity.ts writes and reads it). `data` holds the type's own fields
// as JSON. The id increases with time, so it orders the log and pages it. Rows go with their
// workspace, and a job's event goes with its workflow_job row.
export const activityEvent = sqliteTable(
  "activity_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    // e.g. 'machine.connected' or 'job.routed'.
    type: text("type").notNull(),
    // What the event is about. Each is set for its own kind of event, for joining live state.
    machineId: text("machine_id").references(() => machine.id, { onDelete: "set null" }),
    jobId: integer("job_id").references(() => workflowJob.id, { onDelete: "cascade" }),
    // The user who did it. Null for things RelayRunner or a machine did on their own.
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("activity_event_workspace_idx").on(table.workspaceId, table.id),
    // One event per type per job, so a redelivered webhook never logs a job twice. Machine events
    // have no job id, and NULLs never collide.
    uniqueIndex("activity_event_job_idx").on(table.jobId, table.type),
    // One type over a time range, such as the free checks the Usage page sums.
    index("activity_event_type_idx").on(table.workspaceId, table.type, table.occurredAt),
    // One type over a time range across every workspace, for operator pings (src/operator-pings.ts).
    index("activity_event_type_time_idx").on(table.type, table.occurredAt),
    // Clearing machine_id when a machine is deleted.
    index("activity_event_machine_idx")
      .on(table.machineId)
      .where(sql`${table.machineId} is not null`),
  ],
);

// How each pick walked its workspace's runner order (src/routing.ts decideRoute), one row per run
// attempt, so the Activity page can say why a run's jobs went where they did. Written by the
// PickRunner when it answers. A re-run of failed jobs reuses an earlier attempt's pick, so a job
// reads the newest row at or before its own attempt. Rows go with their workspace.
export const routeDecision = sqliteTable(
  "route_decision",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    repositoryId: integer("repository_id").notNull(),
    runId: integer("run_id").notNull(),
    runAttempt: integer("run_attempt").notNull(),
    // The provider that took the run (a runner order key: 'machine', 'github', 'depot' and so on), or
    // null when nothing fit.
    step: text("step"),
    // What the pick answered: a route's `rr-<id>`, or a GitHub or hosted provider's label. Null
    // when nothing fit.
    runner: text("runner"),
    // The earlier steps, in order, as [{key, reason}].
    skipped: text("skipped", { mode: "json" })
      .$type<{ key: string; reason: string; paused?: string[] }[]>()
      .notNull(),
    // Providers the relay set that the order leaves out.
    notInOrder: text("not_in_order", { mode: "json" }).$type<string[]>().notNull(),
    // The relay's `machine` and `github` inputs, and each hosted provider's input it set, by id.
    machine: text("machine", { mode: "json" }).$type<string[]>().notNull(),
    github: text("github", { mode: "json" }).$type<string[]>().notNull(),
    hosted: text("hosted", { mode: "json" })
      .$type<Partial<Record<HostedProviderId, string[]>>>()
      .notNull()
      .default({}),
    // The message the relay failed with, when nothing fit.
    reason: text("reason"),
    // Who started the run (github.actor) and this attempt (github.triggering_actor), by GitHub
    // account id and login (#241). The id matches a member's GitHub sign-in. Null before #241.
    startedById: integer("started_by_id"),
    startedByLogin: text("started_by_login"),
    triggeredById: integer("triggered_by_id"),
    triggeredByLogin: text("triggered_by_login"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("route_decision_run_idx").on(table.repositoryId, table.runId, table.runAttempt),
    // Operator pings (src/operator-pings.ts): the decisions made in a window, and whether a
    // workspace had a run on a machine before.
    index("route_decision_created_idx").on(table.createdAt),
    index("route_decision_workspace_step_idx").on(table.workspaceId, table.step),
  ],
);

// GitHub Actions usage this billing cycle from each org's billing usage report (#116,
// src/actions-billing.ts): one row per installation, cycle, repo and SKU, summed over the cycle's
// days and replaced on every poll. Keyed by installation, never workspace, because each GitHub
// account has its own included quota.
export const actionsUsage = sqliteTable(
  "actions_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    // Start of the billing cycle (UTC month).
    cycleStart: integer("cycle_start", { mode: "timestamp_ms" }).notNull(),
    // The repo's name within the org, as billing reports it ("" when GitHub omits it).
    repositoryName: text("repository_name").notNull(),
    // e.g. "Actions Linux", "Actions macOS".
    sku: text("sku").notNull(),
    unitType: text("unit_type").notNull(),
    // Minutes for runner SKUs.
    quantity: real("quantity").notNull(),
    // USD before and after GitHub's discounts (included quota, public repos, self-hosted).
    grossAmount: real("gross_amount").notNull(),
    netAmount: real("net_amount").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("actions_usage_row_idx").on(
      table.installationId,
      table.cycleStart,
      table.repositoryName,
      table.sku,
    ),
  ],
);

// Which GitHub accounts installed the opt-in RelayRunner Spend App, which reads org billing
// (src/spend-app.ts). Keyed by GitHub account, since it's installed apart from the main App and
// can come before it. Written by the Spend App's installation webhooks and reconciled hourly.
export const spendInstallation = sqliteTable("spend_installation", {
  accountId: integer("account_id").primaryKey({ autoIncrement: false }),
  accountLogin: text("account_login").notNull(),
  installationId: integer("installation_id").notNull(),
  suspendedAt: integer("suspended_at", { mode: "timestamp_ms" }),
  // When GitHub's view in this row was observed, so an older delivery never overwrites a newer one.
  githubStateAt: integer("github_state_at", { mode: "timestamp_ms" }).notNull(),
  ...timestamps,
});

// What the last billing poll of an installation found: its plan, its Actions budget, and whether
// usage could be read at all. One row per installation.
export const actionsBilling = sqliteTable("actions_billing", {
  installationId: integer("installation_id")
    .primaryKey({ autoIncrement: false })
    .references(() => githubInstallation.id, { onDelete: "cascade" }),
  // GET /orgs/{org} plan.name, e.g. "free", "team", "enterprise".
  plan: text("plan"),
  // The org's Actions budget in whole USD, and whether GitHub blocks jobs once it's spent. Null when
  // the org has no Actions budget.
  budgetAmount: integer("budget_amount"),
  budgetPreventFurtherUsage: integer("budget_prevent_further_usage", { mode: "boolean" }),
  // Why the latest poll couldn't read usage: "missing_permission" or "error". Null when it could.
  failure: text("failure"),
  error: text("error"),
  // The latest poll attempt, and the latest one that read usage.
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
  readAt: integer("read_at", { mode: "timestamp_ms" }),
  ...timestamps,
});

// Each successful poll's running total for the cycle, kept for 48 hours, so the minutes rule (#117)
// can see how fast an account is burning through its quota.
export const actionsUsageReading = sqliteTable(
  "actions_usage_reading",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    readAt: integer("read_at", { mode: "timestamp_ms" }).notNull(),
    // Start of the billing cycle (UTC month) the totals belong to.
    cycleStart: integer("cycle_start", { mode: "timestamp_ms" }).notNull(),
    usedMinutes: real("used_minutes").notNull(),
    grossAmount: real("gross_amount").notNull(),
    netAmount: real("net_amount").notNull(),
  },
  (table) => [
    index("actions_usage_reading_installation_idx").on(table.installationId, table.readAt),
    index("actions_usage_reading_read_idx").on(table.readAt),
  ],
);

// Agent sign-in (MCP server, apps/agents): the jwt and mcp plugins (auth.ts). Generated from
// Better Auth's own schema, so column names follow its fields. jwks holds the keys that sign agent
// access tokens; oauth_consent.reference_id is the agent_grant a consent was given for (below).
export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = sqliteTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: integer("disabled", { mode: "boolean" }).default(false),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    scopes: text("scopes", { mode: "json" }),
    clientCredentialsScopes: text("client_credentials_scopes", {
      mode: "json",
    }).default([]),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts", { mode: "json" }),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris", { mode: "json" }).notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris", { mode: "json" }),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: integer("backchannel_logout_session_required", {
      mode: "boolean",
    }),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types", { mode: "json" }),
    responseTypes: text("response_types", { mode: "json" }),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    dpopBoundAccessTokens: integer("dpop_bound_access_tokens", {
      mode: "boolean",
    }).default(false),
    referenceId: text("reference_id"),
    metadata: text("metadata", { mode: "json" }),
  },
  (table) => [index("oauth_client_user_id_idx").on(table.userId)],
);

export const oauthResource = sqliteTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes", { mode: "json" }),
  customClaims: text("custom_claims", { mode: "json" }),
  dpopBoundAccessTokensRequired: integer("dpop_bound_access_tokens_required", {
    mode: "boolean",
  }).default(false),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  policyVersion: integer("policy_version").default(1),
  metadata: text("metadata", { mode: "json" }),
});

export const oauthClientResource = sqliteTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("oauth_client_resource_client_id_resource_id_uidx").on(
      table.clientId,
      table.resourceId,
    ),
    index("oauth_client_resource_client_id_idx").on(table.clientId),
    index("oauth_client_resource_resource_id_idx").on(table.resourceId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources", { mode: "json" }),
    requestedUserInfoClaims: text("requested_user_info_claims", {
      mode: "json",
    }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    revoked: integer("revoked", { mode: "timestamp_ms" }),
    rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: integer("rotation_replay_expires_at", {
      mode: "timestamp_ms",
    }),
    authTime: integer("auth_time", { mode: "timestamp_ms" }),
    confirmation: text("confirmation", { mode: "json" }),
    scopes: text("scopes", { mode: "json" }).notNull(),
  },
  (table) => [
    index("oauth_refresh_token_client_id_idx").on(table.clientId),
    index("oauth_refresh_token_session_id_idx").on(table.sessionId),
    index("oauth_refresh_token_user_id_idx").on(table.userId),
    index("oauth_refresh_token_authorization_code_id_idx").on(table.authorizationCodeId),
  ],
);

export const oauthAccessToken = sqliteTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources", { mode: "json" }),
    requestedUserInfoClaims: text("requested_user_info_claims", {
      mode: "json",
    }),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "cascade",
    }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    revoked: integer("revoked", { mode: "timestamp_ms" }),
    confirmation: text("confirmation", { mode: "json" }),
    scopes: text("scopes", { mode: "json" }).notNull(),
  },
  (table) => [
    index("oauth_access_token_client_id_idx").on(table.clientId),
    index("oauth_access_token_session_id_idx").on(table.sessionId),
    index("oauth_access_token_user_id_idx").on(table.userId),
    index("oauth_access_token_authorization_code_id_idx").on(table.authorizationCodeId),
    index("oauth_access_token_refresh_id_idx").on(table.refreshId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text("resources", { mode: "json" }),
    requestedUserInfoClaims: text("requested_user_info_claims", {
      mode: "json",
    }),
    scopes: text("scopes", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("oauth_consent_client_id_idx").on(table.clientId),
    index("oauth_consent_user_id_idx").on(table.userId),
  ],
);

export const oauthClientAssertion = sqliteTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

// Which workspaces an agent connection may read (agent-auth.ts). The workspace picker writes a
// grant before consent; the consent's reference_id (and its tokens') is the grant's id. A grant
// tied to the session that made it lets consent find it. Disconnecting an agent from one workspace
// deletes that workspace's row; the agent keeps the others.
export const agentGrant = sqliteTable(
  "agent_grant",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("agent_grant_session_id_idx").on(table.sessionId)],
);

export const agentGrantWorkspace = sqliteTable(
  "agent_grant_workspace",
  {
    grantId: text("grant_id")
      .notNull()
      .references(() => agentGrant.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.workspaceId] }),
    index("agent_grant_workspace_workspace_id_idx").on(table.workspaceId),
  ],
);

// Feedback from people (the dashboard's feedback popover) and agents (the MCP server's
// send_feedback tool), both through routes/feedback.ts, already sanitized and with secrets redacted.
// Also emailed to FEEDBACK_EMAIL. grant_id and client_id are set for agents only, as plain text so
// the feedback outlives a disconnected agent; page is the dashboard path it was sent from. It goes
// with its user.
export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "set null" }),
    grantId: text("grant_id"),
    clientId: text("client_id"),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    details: text("details"),
    tool: text("tool"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    source: text("source", { enum: ["agent", "dashboard"] })
      .notNull()
      .default("agent"),
    page: text("page"),
  },
  (table) => [index("feedback_user_id_created_at_idx").on(table.userId, table.createdAt)],
);

// Runner prices operators record, on top of the base list in @relayrunner/providers
// (BASE_PRICES): USD for a minute of one provider rate from a UTC day (YYYY-MM-DD), until the same
// rate's next row. Global, not per workspace. A wrong row is deleted and added again; a real
// change is a new row from its own day, so past jobs keep the price they ran at.
export const providerPrice = sqliteTable(
  "provider_price",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    rate: text("rate").notNull(),
    usd: real("usd").notNull(),
    from: text("effective_from").notNull(),
    /** Where the price came from: a pricing page URL or a note. */
    source: text("source"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("provider_price_rate_from_idx").on(table.provider, table.rate, table.from),
  ],
);

/** The daily price check's last run per provider's price page (apps/api/src/price-check.ts). */
export const priceCheck = sqliteTable("price_check", {
  provider: text("provider").primaryKey(),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
  /** Why the last check couldn't read the page; null when it could. */
  error: text("error"),
});

/**
 * A price the daily check found that differs from the one jobs are priced at. It prices nothing:
 * an operator approves it into provider_price or dismisses it, and a dismissed one stays so the
 * check doesn't raise the same price again.
 */
export const priceFinding = sqliteTable("price_finding", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  rate: text("rate").notNull(),
  usd: real("usd").notNull(),
  from: text("effective_from").notNull(),
  source: text("source").notNull(),
  foundAt: integer("found_at", { mode: "timestamp_ms" }).notNull(),
  dismissedAt: integer("dismissed_at", { mode: "timestamp_ms" }),
});

/**
 * Providers as operators saved them in the admin (apps/api/src/routes/admin-providers.ts), on top of
 * the code list in @relayrunner/providers (see its catalog.ts). A row for a provider in code
 * replaces its text and links; a row with a new id adds a provider, matched by its label prefixes.
 * Deleting a row puts a provider in code back as it was, or removes an added one.
 */
export const provider = sqliteTable("provider", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  summary: text("summary").notNull(),
  labels: text("labels").notNull(),
  /** JSON array of lowercase label prefixes; ignored for providers in code. */
  prefixes: text("prefixes", { mode: "json" }).$type<string[]>().notNull(),
  example: text("example"),
  setup: text("setup"),
  dashboardUrl: text("dashboard_url"),
  docsUrl: text("docs_url"),
  /** An https image for an added provider's mark; providers in code have their own. */
  logoUrl: text("logo_url"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});
