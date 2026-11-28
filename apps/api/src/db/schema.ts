// Better Auth's tables in the shape its Drizzle adapter expects: the core four (user, session,
// account, verification), then the organization plugin's, renamed to workspaces (see auth.ts).
// Gateway tables (installations and their repos, then machines and routes) follow. After changing anything
// here, run `pnpm db:generate` to write a new migration.
import { JOB_LOG_CHOICES, type MachineSharing } from "@relayrunner/activity";
import type { JobUsage } from "@relayrunner/machine-protocol";
import type { HostedProviderId } from "@relayrunner/providers";
import type { ProviderStatus } from "@relayrunner/providers/catalog";
import type { RetryRunner } from "@relayrunner/runner-order";
import type { StepTime } from "../reports/step-phases.ts";
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
  // When their workspace memberships were last read from GitHub (src/github/memberships.ts), so the
  // dashboard's workspace list only asks GitHub every few minutes.
  installationsSyncedAt: integer("installations_synced_at", { mode: "timestamp_ms" }),
  // The Terms of Service and Privacy Policy versions they last agreed to, and when
  // (@relayrunner/activity LEGAL_VERSIONS, routes/me.ts). Null until they first agree.
  termsVersion: text("terms_version"),
  privacyVersion: text("privacy_version"),
  legalAgreedAt: integer("legal_agreed_at", { mode: "timestamp_ms" }),
  // The IANA time zone the dashboard shows their times and days in (routes/me.ts). Null follows
  // the browser's zone.
  timeZone: text("time_zone"),
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
// the account's login and avatar (src/github/installations.ts ensureWorkspace). Users can't create one.
export const workspace = sqliteTable(
  "workspace",
  {
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
    // JSON RetrySettings (@relayrunner/runner-order): automatic retries of jobs whose runner failed
    // (src/routing/retries.ts). Null means off.
    retrySettings: text("retry_settings"),
    // Whether the Router skips a hosted runner type that stopped picking up jobs
    // (src/routing/provider-health.ts). On unless someone turns it off on the Router page.
    skipUnhealthyRunners: integer("skip_unhealthy_runners", { mode: "boolean" })
      .notNull()
      .default(true),
    // The size, in vCPUs, of a job whose relay hands its runner to the Router (`auto`) and that has
    // no size of its own (auto_job.size). Null means DEFAULT_AUTO_SIZE.
    autoSize: integer("auto_size"),
    // When an owner or admin turned off AI features (src/ai/settings.ts) in Settings › General, and
    // who. Null means on, the default.
    aiOffAt: integer("ai_off_at", { mode: "timestamp_ms" }),
    aiOffBy: text("ai_off_by").references((): AnySQLiteColumn => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // The AI settings read (src/ai/settings.ts) loads the workspaces that turned AI off each minute.
  (table) => [index("workspace_ai_off_idx").on(table.aiOffAt)],
);

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
// by the Setup URL callback and by installation webhooks (src/github/installations.ts); deleting one
// deletes its workspace.
export const githubInstallation = sqliteTable("github_installation", {
  id: integer("id").primaryKey({ autoIncrement: false }),
  accountId: integer("account_id").notNull(),
  accountLogin: text("account_login").notNull(),
  // 'Organization', 'User' or 'Enterprise', as GitHub reports it. An Enterprise install only
  // reads its enterprise's billing (src/github/enterprise.ts): it has no workspace, repos or webhooks, and
  // its account_login is the enterprise's slug.
  accountType: text("account_type").notNull(),
  // 'all' or 'selected': whether the App sees every repo in the account or a chosen list.
  repositorySelection: text("repository_selection").notNull().default("all"),
  suspendedAt: integer("suspended_at", { mode: "timestamp_ms" }),
  // When GitHub's view in this row was observed (a webhook's receivedAt, or a GET
  // /user/installations read). The queue is unordered and retries, so an older observation
  // never overwrites a newer one.
  githubStateAt: integer("github_state_at", { mode: "timestamp_ms" }),
  // The GitHub user id of whoever installed the App (the `installation.created` webhook's sender).
  // They're the workspace's owner (src/github/memberships.ts). Null for installs from before #317.
  installerGithubId: integer("installer_github_id"),
  ...timestamps,
});

// The last 14 days of an installation's workflow runs, read from GitHub once when the App is
// installed (src/run-history.ts), so a new workspace can evaluate a provider against the runs it
// had before RelayRunner saw any webhooks. One row per installation; goes away with it.
export const runHistoryImport = sqliteTable("run_history_import", {
  installationId: integer("installation_id")
    .primaryKey({ autoIncrement: false })
    .references(() => githubInstallation.id, { onDelete: "cascade" }),
  // 'queued', 'running', 'done' or 'failed'.
  state: text("state").notNull(),
  // Runs written so far.
  runs: integer("runs").notNull().default(0),
  error: text("error"),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  ...timestamps,
});

// Which enterprise an org belongs to, learned from the enterprise's billing usage report (each row
// names its org), so an org that shares its enterprise's minutes is judged against them. Kept
// across months: an org with no usage this month is still in its enterprise.
export const githubEnterpriseOrganization = sqliteTable("github_enterprise_organization", {
  // The org's GitHub account id. An org belongs to at most one enterprise.
  organizationId: integer("organization_id").primaryKey({ autoIncrement: false }),
  // The enterprise's installation (a github_installation row with account_type 'Enterprise').
  enterpriseInstallationId: integer("enterprise_installation_id")
    .notNull()
    .references(() => githubInstallation.id, { onDelete: "cascade" }),
  ...timestamps,
});

// A repository an installation can see, mirrored from GitHub so activity can name its repo and
// tell public from private. RelayRunner doesn't manage repos and there is no opt-in: a job that
// asks for `runs-on: relayrunner` from a connected installation is the opt-in. Rows are written by
// webhooks (src/github/repositories.ts) and go away with their installation.
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
  // Where the CLI asked for the code from (src/machines/device-origin.ts), so the approval page can show it
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
// - 'github': a self-hosted runner already registered in a connected org (#159) or on one of its
//   repos (#162).
//   RelayRunner never talks to the machine: it reads the runner's status from GitHub and steers
//   jobs to it with routing_label, a label it added to the runner on GitHub. token_hash and
//   enrollment_hash stay null. It is the org's, so it belongs to its installation's one workspace
//   (workspace_id) and goes with it; user_id is null.
//
// For 'connect' machines: Enrollment runs in two steps (src/machines/machines.ts):
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
    // The machine's second place for jobs, a VM per job (the hello's `isolated`). Null without one.
    isolatedOs: text("isolated_os"),
    isolatedArch: text("isolated_arch"),
    // The size of each job's VM (the hello's `vm`). Null when jobs run on the machine itself.
    vmCpus: integer("vm_cpus"),
    vmMemoryGb: integer("vm_memory_gb"),
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
    // Whose jobs it takes (MACHINE_SHARING, #237): 'only_me' (only jobs of runs its owner,
    // userId, started, re-runs included) or 'anyone'. One setting for every workspace the machine
    // is in. Only the owner changes it. Connected machines start as 'only_me';
    // runners added from GitHub are the org's shared runners and start as 'anyone'.
    sharing: text("sharing").$type<MachineSharing>().notNull().default("only_me"),
    // 'github' only: the installation whose org the runner is registered in, GitHub's runner id,
    // the label RelayRunner added to it (`rr-runner-<hex>`), and the runner's labels as last read
    // from GitHub (JSON array), for when GitHub can't be reached.
    installationId: integer("installation_id").references(() => githubInstallation.id, {
      onDelete: "set null",
    }),
    githubRunnerId: integer("github_runner_id"),
    // 'github' only: the repo a repo-level runner is registered on (GitHub's repository id), which
    // is the only repo whose jobs it takes. Null for a runner registered in the org.
    githubRepositoryId: integer("github_repository_id"),
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
    // 'connect' only: the relayrunner CLI version from its last hello, such as "0.7.0". Null for
    // CLIs older than 0.7.0, which don't send it.
    cliVersion: text("cli_version"),
    // 'connect' only: the Mac app's version, such as "0.2.0", when the Mac app runs the CLI. Null
    // for a CLI run on its own, or one older than this column.
    macAppVersion: text("mac_app_version"),
    // 'connect' only: the actions/runner version from its last hello, such as "2.330.0": the one
    // `connect` installed when it started. Null until a CLI with this column says hello.
    runnerVersion: text("runner_version"),
    ...timestamps,
  },
  (table) => [
    index("machine_workspace_idx").on(table.workspaceId),
    index("machine_user_idx").on(table.userId),
    index("machine_github_runner_idx").on(table.installationId, table.githubRunnerId),
  ],
);

// When each person first ran the Mac app (a hello with macAppVersion from a machine they own), so
// operators hear about it once (src/operator/operator-pings.ts). Written by MachineLink the first
// time one of their machines says hello from the Mac app.
export const macAppFirstUse = sqliteTable(
  "mac_app_first_use",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    machineId: text("machine_id").references(() => machine.id, { onDelete: "set null" }),
    macAppVersion: text("mac_app_version").notNull(),
    firstUsedAt: integer("first_used_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("mac_app_first_use_at_idx").on(table.firstUsedAt)],
);

// Which workspaces a connected machine takes jobs in (#363). Its owner picks them on /device, from
// the Runners page and with `relayrunner workspaces`. A row only counts while the owner is still a
// member there (src/machines/machines.ts inWorkspace), and membership sync deletes the rows for a workspace
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
// with no pick are never stored. Rows are written by workflow_job webhooks (src/ingest/jobs.ts) and go
// away with their installation, or after 90 days (src/ingest/retention.ts).
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
    // Whether any of the job's own steps started (WorkflowJob.ranSteps). False: it ended in
    // GitHub's runner setup. Null when GitHub sent no steps.
    ranSteps: integer("ran_steps", { mode: "boolean" }),
    ...timestamps,
  },
  (table) => [
    index("workflow_job_installation_idx").on(table.installationId, table.id),
    index("workflow_job_run_idx").on(table.runId, table.kind),
    // The pick sweep's recent picks (src/routing/pick-sweep.ts).
    index("workflow_job_kind_created_idx").on(table.kind, table.githubCreatedAt),
    // The jobs each machine is running, and clearing machine_id when a machine is deleted.
    index("workflow_job_machine_idx")
      .on(table.machineId, table.status)
      .where(sql`${table.machineId} is not null`),
  ],
);

// Every job in a connected repo, whatever runner took it (src/ingest/job-timings.ts). While a job is
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
    // The machine a route sent the job to, set with workflow_job's by setJobMachine (src/ingest/jobs.ts),
    // since the job's `rr-<route id>` label stops naming a machine once the route goes. Job times
    // (src/reports/environments.ts) report it as its own environment.
    machineId: text("machine_id"),
    // When GitHub queued the job, for the wait before a runner took it.
    queuedAt: integer("queued_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    // The CPU and memory it used, as its connected machine reported when the job ended. Only
    // machines whose CLI samples report it.
    usage: text("usage", { mode: "json" }).$type<JobUsage>(),
    // From the `completed` webhook's steps: whether any of the job's own steps started (false
    // when the runner never got past "Set up job"), and the first step that failed. Null when
    // GitHub sent no steps, or none failed.
    ranSteps: integer("ran_steps", { mode: "boolean" }),
    failedStep: text("failed_step"),
    // Each step that ran, as [name, seconds], from the `completed` webhook. Read with
    // src/reports/step-phases.ts to split a job's time into setup items and work. Null
    // when GitHub sent no steps.
    steps: text("steps", { mode: "json" }).$type<StepTime[]>(),
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
// report groups by (src/ingest/job-timings.ts), so its 90-day range costs a row per day and runner kind
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

// How many jobs finished, by result, for Admin › Jobs (src/ingest/job-counts.ts). Each job is counted
// once, when job_timing first sees it finish, into three rollups so no read grows with jobs, and
// the chart's doesn't grow with installations either: every installation per hour, each
// installation per hour, and each installation per day. Kept as long as job_timing_daily.
const jobCounters = {
  success: integer("success").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  cancelled: integer("cancelled").notNull().default(0),
};

// Every installation's jobs per UTC hour: the chart and totals.
export const jobCountHour = sqliteTable("job_count_hour", {
  hour: integer("hour", { mode: "timestamp_ms" }).primaryKey(),
  ...jobCounters,
});

// One installation's jobs per UTC hour: the 1-day breakdown, and our own installations' share to
// take out of the chart.
export const jobCount = sqliteTable(
  "job_count",
  {
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    hour: integer("hour", { mode: "timestamp_ms" }).notNull(),
    ...jobCounters,
  },
  (table) => [
    primaryKey({ columns: [table.installationId, table.hour] }),
    // The 1-day breakdown across every installation, and the purge.
    index("job_count_hour_idx").on(table.hour),
  ],
);

// One installation's jobs per UTC day: the breakdown for longer ranges.
export const jobCountDay = sqliteTable(
  "job_count_day",
  {
    day: integer("day", { mode: "timestamp_ms" }).notNull(),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    ...jobCounters,
  },
  (table) => [primaryKey({ columns: [table.day, table.installationId] })],
);

// How long jobs waited for a hosted runner to take them, per UTC day, runner and installation,
// counted once when job_timing first records a job finished (src/ingest/runner-waits.ts). Kept past
// job_timing's raw retention so a public comparison of runners (#492) can later report medians
// and the share started within a minute over any range, and only show a runner once enough
// installations used it. Holds no repo, workflow or label text: a runner is its provider, platform
// and vCPUs. Kept JOB_TIMING_RETENTION_DAYS like the other rollups, and goes away with its
// installation.
export const WAIT_BUCKETS = {
  under10s: 10_000,
  under30s: 30_000,
  under1m: 60_000,
  under2m: 120_000,
  under5m: 300_000,
  under15m: 900_000,
  over15m: Infinity,
} as const;
const waitBuckets = {
  under10s: integer("under_10s").notNull().default(0),
  under30s: integer("under_30s").notNull().default(0),
  under1m: integer("under_1m").notNull().default(0),
  under2m: integer("under_2m").notNull().default(0),
  under5m: integer("under_5m").notNull().default(0),
  under15m: integer("under_15m").notNull().default(0),
  over15m: integer("over_15m").notNull().default(0),
} satisfies Record<keyof typeof WAIT_BUCKETS, unknown>;

export const runnerWaitDay = sqliteTable(
  "runner_wait_day",
  {
    day: integer("day", { mode: "timestamp_ms" }).notNull(),
    // `github` or a hosted provider's id.
    provider: text("provider").notNull(),
    // linux, arm, windows, windows-arm, macos, or other.
    platform: text("platform").notNull(),
    // 0 when the label doesn't say.
    vcpus: integer("vcpus").notNull(),
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    jobs: integer("jobs").notNull().default(0),
    waitMs: integer("wait_ms").notNull().default(0),
    // Jobs per wait bucket, each column the jobs that waited under its time (and at least the
    // previous one's), so medians and percentiles can be read for any range without single jobs.
    ...waitBuckets,
    // Jobs whose runner failed them before any step ran.
    runnerFailures: integer("runner_failures").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.day, table.provider, table.platform, table.vcpus, table.installationId],
    }),
    // The cascade when an installation is removed; reads go by day.
    index("runner_wait_day_installation_idx").on(table.installationId),
  ],
);

// What each GitHub account spent on each priced hosted provider per UTC calendar month, at list
// prices, counted once when job_timing first records a job finished (src/providers/provider-spend.ts). A
// hosted step with a spend limit reads its row when it's reached, so the check is one key lookup.
// Months that start before JOB_TIMING_RETENTION_DAYS are purged hourly.
export const providerSpendMonth = sqliteTable(
  "provider_spend_month",
  {
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    // The UTC midnight starting the month.
    month: integer("month", { mode: "timestamp_ms" }).notNull(),
    provider: text("provider").notNull(),
    // Millionths of a dollar, so sums of per-minute prices stay whole numbers.
    usdMicros: integer("usd_micros").notNull().default(0),
    jobs: integer("jobs").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.installationId, table.month, table.provider] }),
    // The hourly purge of past months.
    index("provider_spend_month_month_idx").on(table.month),
  ],
);

// One attempt of a GitHub Actions workflow run in a connected repo, from workflow_run webhooks
// (src/reports/runs.ts), for the Runs page: what started it and how it ended. Its jobs' times come from
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
    // The workflow's id and file (.github/workflows/ci.yml). Null for runs stored before signals.
    workflowId: integer("workflow_id"),
    workflowPath: text("workflow_path"),
    // The repo's default branch when the run was seen, so signals can leave it out.
    defaultBranch: text("default_branch"),
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
    // The coding agent the run came from (AgentId in @relayrunner/api-types), from the account that
    // started it or a trailer in its head commit's message. Null for none, and for runs stored before it was read.
    agent: text("agent"),
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
    // Signals (src/reports/signals.ts): newer runs on the same branch, and the same commit's other runs.
    index("workflow_run_branch_idx").on(table.repositoryId, table.headBranch, table.runStartedAt),
    index("workflow_run_sha_idx").on(table.repositoryId, table.headSha),
  ],
);

// What the Signals page reports (src/reports/signals.ts), summed per UTC day, repo and subject (a workflow,
// or a workflow's job), so its 90-day range reads a few rows per day instead of every run. The
// hourly cron recomputes each active installation's current day from job_timing and
// workflow_run, so a late webhook still lands. Purged with job_timing_daily, and gone with the
// installation.
export const signalDay = sqliteTable(
  "signal_day",
  {
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    // The UTC midnight starting the day the jobs finished on.
    day: integer("day", { mode: "timestamp_ms" }).notNull(),
    // A SignalId, 'total' for every job the usage report counts, or 'by-person', 'by-workflow',
    // 'by-branch' or 'by-trigger' for the Breakdown, whose subject is that value. Only workflows
    // keep their repo: the other Breakdown rows have repository_id 0.
    signal: text("signal").notNull(),
    repositoryId: integer("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    // The workflow name, or "workflow › job". Empty on 'total' rows and the Breakdown's rest.
    subject: text("subject").notNull(),
    workflowPath: text("workflow_path"),
    // On queue-waits rows, the runner the jobs went to, as a Job times environment key, so the page
    // can open its panel: one machine when they all ran there, or else their labels' environment.
    runnerKey: text("runner_key"),
    // What the signal counts: runs, commits or jobs. Runs on Breakdown rows.
    count: integer("count").notNull(),
    // The job time the signal covers, and its estimated cost in USD.
    runMs: integer("run_ms").notNull(),
    cost: real("cost").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.installationId, table.day, table.signal, table.repositoryId, table.subject],
    }),
    // The retention purge, across all installations.
    index("signal_day_day_idx").on(table.day),
  ],
);

// The parts of the repo a pull request changes (src/checks/pull-request-paths.ts), for the Signals page:
// its files' top folders, and whether every file is docs. One row per pull request, read again
// when a newer run's head commit differs from the one read. Purged with signal_day, and gone with
// the installation.
export const pullRequestPaths = sqliteTable(
  "pull_request_paths",
  {
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    repositoryId: integer("repository_id").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    // The run's head commit when the files were read.
    headSha: text("head_sha").notNull(),
    // Distinct areas, such as "docs", "apps/web" or "/" for files at the root. Empty when the pull
    // request changes more files than GitHub lists.
    areas: text("areas", { mode: "json" }).$type<string[]>().notNull(),
    // Whether every changed file is docs. False when there were too many files to tell.
    docsOnly: integer("docs_only", { mode: "boolean" }).notNull(),
    readAt: integer("read_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.repositoryId, table.pullRequestNumber] }),
    // The retention purge, across all installations.
    index("pull_request_paths_read_idx").on(table.readAt),
  ],
);

// An automatic retry (src/routing/retries.ts): RelayRunner re-ran the relay of a run attempt whose routed
// job its runner failed, so the next attempt picks again. One row per retried attempt, written
// before the re-run is asked for, so a redelivered webhook can never retry twice. The next
// attempt's pick reads it to place the retry and keep the original attempt's starter.
export const jobRetry = sqliteTable(
  "job_retry",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    repositoryId: integer("repository_id").notNull(),
    runId: integer("run_id").notNull(),
    // The attempt that failed. The retry is the next one.
    runAttempt: integer("run_attempt").notNull(),
    // The job that failed and the relay that was re-run.
    jobId: integer("job_id").notNull(),
    relayJobId: integer("relay_job_id").notNull(),
    // A RetryKind (@relayrunner/activity).
    kind: text("kind").notNull(),
    // Where the retry goes (RetryRunner).
    runner: text("runner").$type<RetryRunner>().notNull(),
    // Where the job failed: the runner order step, and the machine when it ran on one.
    failedStep: text("failed_step"),
    failedMachineId: text("failed_machine_id"),
    // Who started the failed attempt (github.triggering_actor). GitHub credits the re-run to the
    // App, so the retry's pick uses this instead.
    triggeredById: integer("triggered_by_id"),
    triggeredByLogin: text("triggered_by_login"),
    // 'requested' once GitHub took the re-run, 'failed' when it refused (with `error`).
    status: text("status", { enum: ["pending", "requested", "failed"] }).notNull(),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("job_retry_attempt_idx").on(table.repositoryId, table.runId, table.runAttempt),
    // The daily cap: one workspace's retries over the last day.
    index("job_retry_workspace_idx").on(table.workspaceId, table.createdAt),
  ],
);

// The workspace's audit log for the Activity page: one append-only row per event, typed by
// @relayrunner/activity (src/reports/activity.ts writes and reads it). `data` holds the type's own fields
// as JSON. The id increases with time, so it orders the log and pages it. Rows go with their
// workspace or after 90 days (src/ingest/retention.ts), and a job's event goes with its workflow_job row.
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
    // One type over a time range across every workspace, for operator pings (src/operator/operator-pings.ts).
    index("activity_event_type_time_idx").on(table.type, table.occurredAt),
    // Clearing machine_id when a machine is deleted.
    index("activity_event_machine_idx")
      .on(table.machineId)
      .where(sql`${table.machineId} is not null`),
  ],
);

// Each job whose relay hands its runner to the Router (`blacksmith: auto`, or no inputs), by its
// repo, workflow file and relay job, with what the Router page set for it. A pick of such a job adds
// or touches its row (src/routing/auto-jobs.ts), so the Router page lists the jobs it can size. Rows go with
// their workspace.
export const autoJob = sqliteTable(
  "auto_job",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    repositoryId: integer("repository_id").notNull(),
    repository: text("repository").notNull(),
    // The workflow file, such as `.github/workflows/ci.yml`, or the workflow's name when GitHub
    // didn't say. With the relay job, what identifies the job across renames of the workflow.
    workflowPath: text("workflow_path").notNull(),
    workflow: text("workflow"),
    // The relay's job in the caller workflow, such as `relay-test`.
    relayJob: text("relay_job").notNull(),
    // The job's size in vCPUs, or null for the workspace's (workspace.auto_size).
    size: integer("size"),
    // The relay's `cpus` input on the job's last pick, or null when it set none. It wins over size.
    cpus: integer("cpus"),
    // A runner order key to try before the rest of the order, or null for the order as it is.
    first: text("first"),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
    // The job's last pick. 0 for a size saved before the job's repo routed (planAutoJobs), which
    // keeps it off the Router page until its first pick.
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("auto_job_identity_idx").on(
      table.workspaceId,
      table.repositoryId,
      table.workflowPath,
      table.relayJob,
    ),
  ],
);

// A repository's own runner order (#709), which its jobs walk instead of the workspace's
// (workspace.runner_order). A full copy, not changes to the workspace's: editing the workspace's
// order leaves it as it is. Caps still count the GitHub account's minutes and spend, shared with the
// workspace's other repositories (src/routing/runner-orders.ts). Removing the row puts the repository back
// on the workspace's order.
export const repoRunnerOrder = sqliteTable(
  "repo_runner_order",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    // GitHub's repository id, stable across renames, and its owner/name when the order was saved.
    repositoryId: integer("repository_id").notNull(),
    repository: text("repository").notNull(),
    // JSON RunnerOrder (@relayrunner/runner-order).
    runnerOrder: text("runner_order").notNull(),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.repositoryId] })],
);

// How each pick walked its workspace's runner order (src/routing/routing.ts decideRoute), one row per pick
// (a run attempt can have several relay jobs, each routing its own job), so the Activity page can
// say why a run's jobs went where they did. Written by the PickRunner when it answers. A re-run of
// failed jobs reuses an earlier attempt's picks, so a job reads the newest row at or before its own
// attempt, matched by the label it runs on. Rows go with their workspace, or after 90 days
// (src/ingest/retention.ts).
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
    // The relay job the pick answered, by the runner protocol's job id, so a redelivered pick keeps
    // its first decision and each relay of an attempt keeps its own. Null before #661.
    pickJobId: text("pick_job_id"),
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
    // Whether the walk was the repo's own runner order (repo_runner_order) instead of the
    // workspace's. False before #709.
    ownOrder: integer("own_order", { mode: "boolean" }).notNull().default(false),
    // The relay's `machine` and `github` inputs, and each hosted provider's input it set, by id.
    machine: text("machine", { mode: "json" }).$type<string[]>().notNull(),
    github: text("github", { mode: "json" }).$type<string[]>().notNull(),
    hosted: text("hosted", { mode: "json" })
      .$type<Partial<Record<HostedProviderId, string[]>>>()
      .notNull()
      .default({}),
    // The message the relay failed with, when nothing fit.
    reason: text("reason"),
    // When every machine that fit was full and the job queued for a slot (Router.wait), instead of
    // getting a runner right away. Null for picks that didn't wait, and before #456.
    waitedAt: integer("waited_at", { mode: "timestamp_ms" }),
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
    uniqueIndex("route_decision_pick_idx").on(
      table.repositoryId,
      table.runId,
      table.runAttempt,
      table.pickJobId,
    ),
    // Operator pings (src/operator/operator-pings.ts): the decisions made in a window, and whether a
    // workspace had a run on a machine before. Admin › Workspaces (src/operator/admin-adoption.ts): each
    // workspace's first run on a machine, read from the index alone.
    index("route_decision_created_idx").on(table.createdAt),
    index("route_decision_step_workspace_idx").on(table.step, table.workspaceId, table.createdAt),
    // The Router page's routing outcomes (src/reports/route-outcomes.ts): a workspace's decisions in a window.
    index("route_decision_workspace_idx").on(table.workspaceId, table.createdAt),
  ],
);

// GitHub Actions usage this billing cycle from each org's billing usage report (#116,
// src/providers/actions-billing.ts): one row per installation, cycle, repo and SKU, summed over the cycle's
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

// Each UTC day's private-repo Actions minutes this cycle (Linux 2-core quota minutes), so the
// dashboard can project when an account's included minutes run out at its recent pace
// (src/providers/minutes-projection.ts). Every poll replaces the installation's rows, so only the
// current cycle is kept.
export const actionsUsageDay = sqliteTable(
  "actions_usage_day",
  {
    installationId: integer("installation_id")
      .notNull()
      .references(() => githubInstallation.id, { onDelete: "cascade" }),
    // YYYY-MM-DD, UTC.
    day: text("day").notNull(),
    usedMinutes: real("used_minutes").notNull(),
  },
  (table) => [primaryKey({ columns: [table.installationId, table.day] })],
);

// Which GitHub accounts installed the opt-in RelayRunner Spend App, which reads org billing
// (src/github/spend-app.ts). Keyed by GitHub account, since it's installed apart from the main App and
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
    // Whether the agent may change settings in this workspace (agent-auth.ts AGENT_WRITE_ROUTES).
    // Off until an owner or admin turns it on in Settings → Agents.
    canWrite: integer("can_write", { mode: "boolean" }).notNull().default(false),
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
    // None for an anonymous crash report from the Mac app, which records only its machine.
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "set null" }),
    machineId: text("machine_id").references(() => machine.id, { onDelete: "set null" }),
    grantId: text("grant_id"),
    clientId: text("client_id"),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    details: text("details"),
    tool: text("tool"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    source: text("source", { enum: ["agent", "dashboard", "machine"] })
      .notNull()
      .default("agent"),
    page: text("page"),
  },
  (table) => [
    index("feedback_user_id_created_at_idx").on(table.userId, table.createdAt),
    index("feedback_machine_id_created_at_idx").on(table.machineId, table.createdAt),
  ],
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

/** The daily price check's last run per provider's price page (apps/api/src/providers/price-check.ts). */
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
 * GitHub's actions/runner releases, refreshed hourly (src/machines/runner-releases.ts), so the dashboard can
 * say when a machine's runner is behind and how long until GitHub stops sending it jobs.
 */
export const runnerRelease = sqliteTable("runner_release", {
  version: text("version").primaryKey(),
  publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
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
  /** An https price file the provider publishes (price-file.ts in @relayrunner/providers). */
  priceUrl: text("price_url"),
  /** live | hidden | off (ProviderStatus in @relayrunner/providers/catalog). */
  status: text("status").$type<ProviderStatus>().notNull().default("live"),
  /** Listed first on the Providers page. Null keeps the code's choice. */
  featured: integer("featured", { mode: "boolean" }),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

// Emails a person turned off, one row per type (src/notifications.ts lists the types). No row
// means the email is on. Emails that keep an account safe, like a machine taken over, always send.
export const notificationSetting = sqliteTable(
  "notification_setting",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.userId, table.type] })],
);

// A third-party runner provider account a workspace connected for real usage and billing
// (src/provider-billing): the read-only API token its owner or an admin pasted, encrypted with
// PROVIDER_TOKEN_KEY (src/providers/provider-tokens.ts). The token is never sent back; the dashboard sees
// only its last four characters. The hourly cron syncs each connection (src/providers/provider-sync.ts).
export const providerConnection = sqliteTable(
  "provider_connection",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    // A BILLING_PROVIDER_IDS id from @relayrunner/providers, such as "depot".
    provider: text("provider").notNull(),
    // "v<key version>.<iv>.<ciphertext>", base64url. Bound to this workspace and provider.
    token: text("token").notNull(),
    tokenHint: text("token_hint").notNull(),
    // Provider-specific settings, such as Namespace's region. JSON object.
    options: text("options", { mode: "json" }).$type<Record<string, string>>().notNull(),
    // The account the token belongs to, as the provider names it, when it says.
    accountName: text("account_name"),
    connectedBy: text("connected_by").references(() => user.id, { onDelete: "set null" }),
    // The end of the window the last successful sync read, so the next starts there.
    syncedThrough: integer("synced_through", { mode: "timestamp_ms" }),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    // Why the last sync failed: "token_rejected" or "error". Null after a successful one.
    failure: text("failure"),
    error: text("error"),
    failedAt: integer("failed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.provider] })],
);

// One job a connected provider ran, as its API reports it, keyed by GitHub's job id so it lines up
// with job_timing. Replaced on every sync that sees the job again, and purged after 90 days.
export const providerJobUsage = sqliteTable(
  "provider_job_usage",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    // GitHub's job id, as text: providers send it as a string or a 64-bit number.
    jobId: text("job_id").notNull(),
    runId: text("run_id"),
    repository: text("repository"),
    jobName: text("job_name"),
    runnerLabel: text("runner_label"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    // What the provider bills for the job, in seconds, and the wait before it started.
    billableSeconds: real("billable_seconds"),
    queueSeconds: real("queue_seconds"),
    // USD the provider says the job cost. Null when it only reports time.
    costUsd: real("cost_usd"),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.provider, table.jobId] }),
    // One workspace's jobs over a time range.
    index("provider_job_usage_workspace_idx").on(table.workspaceId, table.finishedAt),
    // The retention purge, across all workspaces.
    index("provider_job_usage_finished_idx").on(table.finishedAt),
  ],
);

// A connected provider's own daily totals, for providers that report usage per day rather than (or
// as well as) per job. `unit` says what `quantity` counts, such as "unit_minutes" for Namespace.
// Replaced on every sync that reads the day, and purged after 90 days.
export const providerDailyUsage = sqliteTable(
  "provider_daily_usage",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    // UTC midnight.
    day: integer("day", { mode: "timestamp_ms" }).notNull(),
    unit: text("unit").notNull(),
    quantity: real("quantity").notNull(),
    // USD, when the provider reports it.
    costUsd: real("cost_usd"),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.provider, table.day, table.unit] }),
    // The retention purge, across all workspaces.
    index("provider_daily_usage_day_idx").on(table.day),
  ],
);

// Where a workspace sends its CI traces (Settings → Telemetry, src/telemetry): each finished run
// and job as OpenTelemetry spans, POSTed to `endpoint` as OTLP/HTTP JSON. The header values (API
// keys) are one JSON object, encrypted like provider tokens (src/providers/provider-tokens.ts) and never sent
// back; the dashboard sees each header's name and last four characters. One per workspace.
// How a telemetry export or log bucket is doing, and which jobs' logs it takes. Both tables have
// these, so src/telemetry/otlp.ts records sends the same way for either.
export const exportStatus = () => ({
  lastSentAt: integer("last_sent_at", { mode: "timestamp_ms" }),
  // The latest refusal or network error, when the current run of failures began, and when the
  // latest one happened. Cleared by the next successful send. A day without tries starts a new
  // run. Past FAILING_DAYS of nothing but failures the export pauses and sets pausedAt, until its
  // settings are saved again.
  error: text("error"),
  failingSince: integer("failing_since", { mode: "timestamp_ms" }),
  failedAt: integer("failed_at", { mode: "timestamp_ms" }),
  pausedAt: integer("paused_at", { mode: "timestamp_ms" }),
  // Which finished jobs' logs go out (src/telemetry/logs.ts): none, failed ones, or all.
  logs: text("logs", { enum: JOB_LOG_CHOICES }).notNull().default("off"),
  // Why the latest job's log wasn't sent, such as GitHub no longer having it, and when.
  logsSkipped: text("logs_skipped"),
  logsSkippedAt: integer("logs_skipped_at", { mode: "timestamp_ms" }),
});

export const telemetryExport = sqliteTable("telemetry_export", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  // The OTLP base URL, such as https://api.honeycomb.io. Traces go to `${endpoint}/v1/traces`,
  // logs to `${endpoint}/v1/logs`.
  endpoint: text("endpoint").notNull(),
  // "v<key version>.<iv>.<ciphertext>" of a JSON object of header name to value.
  headers: text("headers").notNull(),
  headerHints: text("header_hints", { mode: "json" })
    .$type<{ name: string; hint: string }[]>()
    .notNull(),
  // The resource's service.name.
  serviceName: text("service_name").notNull(),
  // Traces. Logs are exportStatus's `logs`; a pause stops both.
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  ...exportStatus(),
  ...timestamps,
});

// An S3-compatible bucket a workspace archives job logs to (Settings → Telemetry), one gzipped
// NDJSON object per job (src/telemetry/bucket.ts).
export const logBucket = sqliteTable("log_bucket", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  // The S3 API URL, such as https://<account>.r2.cloudflarestorage.com.
  endpoint: text("endpoint").notNull(),
  bucket: text("bucket").notNull(),
  // "auto" for R2 and Google Cloud Storage.
  region: text("region").notNull(),
  // Where in the bucket objects go, empty or ending in "/".
  prefix: text("prefix").notNull(),
  // "v<key version>.<iv>.<ciphertext>" of a JSON { accessKeyId, secretAccessKey }.
  credentials: text("credentials").notNull(),
  // The access key id's last four characters.
  keyHint: text("key_hint").notNull(),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  ...exportStatus(),
  ...timestamps,
});
// AI model calls (src/ai): the switch for every workspace at once, and the defaults each workspace
// starts from. One row, id "global"; with no row, AI is off. Operators change it in Admin › AI.
export const aiSetting = sqliteTable("ai_setting", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  // The AiFeature ids (src/ai/settings.ts) turned on anywhere. A workspace can narrow them.
  features: text("features", { mode: "json" }).$type<string[]>().notNull(),
  // Input plus output tokens a day, for one workspace (unless its own row says otherwise) and for
  // all of them together. Past either, calls stop until the next UTC day.
  workspaceDailyTokens: integer("workspace_daily_tokens").notNull(),
  dailyTokens: integer("daily_tokens").notNull(),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Operator overrides for one workspace's AI, set in Admin › AI: a block, fewer features or another
// budget. A workspace can also turn AI off itself (workspace.ai_off_at); no row means allowed.
export const workspaceAiSetting = sqliteTable("workspace_ai_setting", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  // The features this workspace may use, within the global ones. Null means all of them.
  features: text("features", { mode: "json" }).$type<string[]>(),
  // Overrides ai_setting.workspace_daily_tokens for this workspace. Null uses the default.
  dailyTokens: integer("daily_tokens"),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// AI calls per workspace, feature and UTC day: what the budgets count and Admin › AI shows.
// Purged after 90 days.
export const aiUsageDay = sqliteTable(
  "ai_usage_day",
  {
    day: integer("day", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    // Model calls made, answers served from ai_cache instead, calls refused by a budget or the
    // rate limit, and calls that failed.
    calls: integer("calls").notNull().default(0),
    cacheHits: integer("cache_hits").notNull().default(0),
    limited: integer("limited").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.workspaceId, table.feature] }),
    // One workspace's recent days, for its budget and the admin page.
    index("ai_usage_day_workspace_idx").on(table.workspaceId, table.day),
  ],
);

// Answers the model already gave, by a hash of the feature, its question version, the model and
// the input (src/ai/cache.ts), so the same question costs one call. Kept per workspace; expired
// rows are purged hourly.
export const aiCache = sqliteTable(
  "ai_cache",
  {
    key: text("key").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    // The model's answers object, as JSON.
    answers: text("answers").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("ai_cache_expires_idx").on(table.expiresAt),
    // Turning off AI deletes a workspace's answers (setWorkspaceAi).
    index("ai_cache_workspace_idx").on(table.workspaceId),
  ],
);

// What a job does (lint, tests, a build...), as the AI model read it from the job's name, its
// workflow's and its runner labels (src/ai/job-type.ts). One row per workspace, repository,
// workflow and job; matrix legs share their job's row. Filled a few jobs at a time by the hourly
// signals task while AI is on for the workspace.
export const jobType = sqliteTable(
  "job_type",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    repositoryId: integer("repository_id").notNull(),
    // The workflow's name, or "" when GitHub sent none.
    workflow: text("workflow").notNull(),
    // The job's name, without a matrix leg's "(…)".
    job: text("job").notNull(),
    // A JOB_TYPES id (src/ai/job-type.ts).
    kind: text("kind").notNull(),
    confidence: real("confidence").notNull(),
    classifiedAt: integer("classified_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.repositoryId, table.workflow, table.job] }),
  ],
);

// Something that keeps failing and that someone should hear about (src/operator/health-issues.ts): a cron
// task, an installation's queued task, or a workspace's broken integration. One row per
// thing, by `key`. It opens on a failure and clears on the next success; alerts go out when it
// passes its threshold, twice more over the next week while it stays open, and when it clears.
export const healthIssue = sqliteTable(
  "health_issue",
  {
    // What failed, e.g. "cron:syncRunnerReleases", "task:signals:<installation id>" or
    // "integration:app-suspended:<workspace id>".
    key: text("key").primaryKey(),
    // A HEALTH_ISSUE_KINDS id: "cron", "task" or "integration".
    kind: text("kind").notNull(),
    // The latest error, cut short, or what's wrong with an integration.
    error: text("error").notNull(),
    // Failures in a row since the last success.
    failures: integer("failures").notNull(),
    firstFailedAt: integer("first_failed_at", { mode: "timestamp_ms" }).notNull(),
    // Set by the first success after failures; the row is deleted once that's been told.
    clearedAt: integer("cleared_at", { mode: "timestamp_ms" }),
    // How many times this run of failures was told, and when last. Null until it passed its
    // threshold.
    alerts: integer("alerts").notNull().default(0),
    alertedAt: integer("alerted_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("health_issue_kind_idx").on(table.kind)],
);

// A provider evaluation (src/reports/evaluations.ts): one workflow dispatched on its repo's default branch
// and re-run until it has `runs` attempts, every relay job in it answered with `label` instead of
// the workspace's runner order. Keyed for the pick by (repository_id, run_id); run_id is null
// between inserting the row and GitHub's dispatch answer. Gone with the workspace.
export const evaluation = sqliteTable(
  "evaluation",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    repositoryId: integer("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    // The workflow's file, such as .github/workflows/ci.yml, and its name when it last ran.
    workflowPath: text("workflow_path").notNull(),
    workflowName: text("workflow_name"),
    // The hosted provider being evaluated, the size asked for in vCPUs, and the label that gets it.
    provider: text("provider").notNull(),
    vcpus: integer("vcpus").notNull(),
    label: text("label").notNull(),
    // The branch the workflow was dispatched on.
    ref: text("ref").notNull(),
    // How many attempts to run, one after another.
    runs: integer("runs").notNull(),
    runId: integer("run_id"),
    // The attempt running now: 1 once dispatched, raised before each re-run, so a redelivered
    // `completed` for an earlier attempt can't start a second re-run.
    attempt: integer("attempt").notNull().default(1),
    // dispatching: row written, waiting on GitHub's answer. waiting: the workflow has no
    // workflow_dispatch trigger yet (`error` no_dispatch); the next push to `ref` that runs it
    // dispatches again. running: attempts going. done: every attempt finished. failed: an attempt
    // failed or GitHub refused (see `error`). cancelled: stopped from the dashboard.
    state: text("state", {
      enum: ["dispatching", "waiting", "running", "done", "failed", "cancelled"],
    }).notNull(),
    error: text("error"),
    startedById: text("started_by_id").references(() => user.id, { onDelete: "set null" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("evaluation_run_idx").on(table.repositoryId, table.runId),
    index("evaluation_workspace_idx").on(table.workspaceId, table.createdAt),
  ],
);
