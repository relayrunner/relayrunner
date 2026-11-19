import type { McpServer } from "@modelcontextprotocol/server";
import {
  ACTIVITY_FILTERS,
  ACTIVITY_RESULTS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_LIMITS,
  type ActivityPage,
} from "@relayrunner/activity";
import { z } from "zod";
import type { Api } from "./api.ts";
import { answer, type ToolContext, workspaceArg } from "./context.ts";
import { compactActivityPage, compactJobTimes, contains } from "./compact.ts";

// Read-only tools over relayrunner-api's dashboard endpoints, plus send_feedback, which only
// records a report for the RelayRunner team; the tools that change settings are in write-tools.ts.
// Each answers JSON. All are D1 reads except get_run_failures, which reads a few failed jobs' logs
// from GitHub. None takes the Router's lock (apps/api/src/agent-auth.ts keeps it that way).

// Avatars and dashboard-only permissions aren't useful to an agent.
const DASHBOARD_ONLY = new Set(["ownerImage", "canRevoke", "mine"]);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const days = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Days to look back (1-${max}).`);

export function registerTools(server: McpServer, context: ToolContext) {
  const { request, workspaces, workspaceId, workspacePath } = context;

  // The API, about the workspace a call names.
  const scoped =
    (workspace: string | undefined): Api =>
    (path, query) =>
      request(path, { query, workspaceId: workspaceId(workspace) });

  // A /workspaces/:id route, for the workspace a call names.
  const workspaceRoute = <T>(workspace: string | undefined, route: string) =>
    request<T>(workspacePath(workspace, route));

  server.registerTool(
    "list_workspaces",
    {
      title: "Workspaces",
      description:
        "The RelayRunner workspaces this connection can read, by id and name, and whether it may change settings in each (canWrite: an owner or admin turned on Allow changes for it in Settings → Agents). Pass one as `workspace` to the other tools; get_workspace has your role and GitHub accounts in each.",
      annotations: READ_ONLY,
    },
    () => answer(async () => ({ workspaces })),
  );

  server.registerTool(
    "get_workspace",
    {
      title: "Workspace",
      description:
        "One RelayRunner workspace in full: its name, your role in it, and the GitHub accounts (orgs or users) connected to it, with their install settings.",
      inputSchema: z.object({ workspace: workspaceArg }),
      annotations: READ_ONLY,
    },
    ({ workspace }) => answer(() => scoped(workspace)("/workspaces/current")),
  );

  server.registerTool(
    "list_runners",
    {
      title: "Runners",
      description:
        "Every runner in the workspace: machines connected with the RelayRunner CLI and self-hosted runners added from GitHub. Each has its labels, whether it's online, idle or busy (and the job it's running), whether it's paused, and whose jobs it takes. Runners added from GitHub show github.unreachable because this tool doesn't ask GitHub for their live status; check the dashboard for that.",
      inputSchema: z.object({ workspace: workspaceArg }),
      annotations: READ_ONLY,
    },
    ({ workspace }) =>
      answer(async () => {
        const { machines } = await scoped(workspace)<{ machines: Record<string, unknown>[] }>(
          "/machines",
        );
        return {
          runners: machines.map((machine) =>
            Object.fromEntries(Object.entries(machine).filter(([key]) => !DASHBOARD_ONLY.has(key))),
          ),
        };
      }),
  );

  server.registerTool(
    "get_runner_order",
    {
      title: "Runner order",
      description:
        "The workspace's runner order: the providers RelayRunner tries for a job, top to bottom ('machine' for connected machines, 'github' for GitHub-hosted runners, optionally with a monthly minutes limit, and hosted providers by id: 'blacksmith', 'depot', 'namespace', 'warpbuild', 'ubicloud', 'boat', 'runs-on', 'starsling', 'monkci', 'runloft', 'latchkey', 'berrybox', 'celesto', 'instabox', 'lizard', optionally with a monthly spendLimit in dollars). A job goes to the first provider it allows that can take it. A minutes limit counts the job's GitHub account's minutes, or its enterprise's shared minutes for an org in a GitHub enterprise. isDefault is true when nobody has changed it.",
      inputSchema: z.object({ workspace: workspaceArg }),
      annotations: READ_ONLY,
    },
    ({ workspace }) => answer(() => workspaceRoute(workspace, "runner-order")),
  );

  server.registerTool(
    "list_workflows",
    {
      title: "Workflows",
      description:
        "Every workflow that ran in the workspace's repos in the last 14 days, with its runs and how many went through RelayRunner (routedRuns). Workflows with no routed runs come first: those are what's left to route. Also the hosted provider runner labels jobs ran on, with job counts.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: z
          .string()
          .optional()
          .describe("Only workflows in repositories whose owner/name contains this."),
      }),
      annotations: READ_ONLY,
    },
    ({ workspace, repository }) =>
      answer(async () => {
        const setup = await workspaceRoute<{ workflows: { repository: string }[] }>(
          workspace,
          "router-setup",
        );
        return {
          ...setup,
          workflows: setup.workflows.filter((row) => contains(row.repository, repository)),
        };
      }),
  );

  server.registerTool(
    "list_runs",
    {
      title: "Workflow runs",
      description:
        "Recent workflow runs (last 14 days), newest first: repository, workflow, branch, commit sha, who started it, status, conclusion, wall time against the workflow's usual time, where its jobs ran, and whether RelayRunner routed it. Use get_run_jobs for one run's jobs and list_activity for why a job went where it did.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: z
          .string()
          .optional()
          .describe("Only runs in repositories whose owner/name contains this."),
        status: z.enum(["queued", "in_progress", "completed"]).optional(),
        conclusion: z
          .string()
          .optional()
          .describe("Only completed runs with this conclusion, like failure or success."),
        routed: z.boolean().optional().describe("Only runs RelayRunner routed (or didn't)."),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ_ONLY,
    },
    ({ workspace, repository, status, conclusion, routed, limit }) =>
      answer(async () => {
        const report = await scoped(workspace)<{
          runs: (Record<string, unknown> & { repository: string })[];
          truncated: boolean;
        }>("/runs");
        const runs = report.runs.filter(
          (run) =>
            contains(run.repository, repository) &&
            (!status || run.status === status) &&
            (!conclusion || run.conclusion === conclusion) &&
            (routed === undefined || run.routed === routed),
        );
        return { ...report, runs: runs.slice(0, limit), matching: runs.length };
      }),
  );

  server.registerTool(
    "get_run_jobs",
    {
      title: "Run jobs",
      description:
        "One workflow run attempt's jobs: each job's status, conclusion, timings and the environment it ran on (or is waiting for). Take repositoryId and runId from list_runs.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repositoryId: z.number().int().positive(),
        runId: z.number().int().positive(),
        runAttempt: z.number().int().positive().default(1),
      }),
      annotations: READ_ONLY,
    },
    ({ workspace, repositoryId, runId, runAttempt }) =>
      answer(() => scoped(workspace)(`/runs/${repositoryId}/${runId}/${runAttempt}/jobs`)),
  );

  server.registerTool(
    "get_run_failures",
    {
      title: "Run failures",
      description:
        "Why a run attempt's jobs failed, without reading whole logs: each failed job's first failed step, whether its runner failed it before any step ran (an infrastructure failure, not the code), GitHub's annotations, up to 50 lines of its log ending at the last error, and `cause` when AI is on for the workspace: the likely kind (flaky, lint, test, build, infra or config), how sure it is, the chance a re-run passes (passesOnRerun, 0-1), and `rerun` (passes or fails) when the model is sure enough to say. Covers up to 5 failed jobs; `more` counts the rest. Take repositoryId and runId from list_runs.",
      inputSchema: z.object({
        workspace: workspaceArg,
        repositoryId: z.number().int().positive(),
        runId: z.number().int().positive(),
        runAttempt: z.number().int().positive().default(1),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    ({ workspace, repositoryId, runId, runAttempt }) =>
      answer(() => scoped(workspace)(`/runs/${repositoryId}/${runId}/${runAttempt}/failures`)),
  );

  server.registerTool(
    "list_activity",
    {
      title: "Activity",
      description:
        "The workspace's activity log, newest first: jobs (where RelayRunner routed each one, which providers it skipped and why), optimized checks, machines connecting, pausing or going offline, and member changes. Items are compact (type, time, repo, job, runner, conclusion, route step and skipped reasons); pass detail for urls, sha, who started each run and the route's label inputs. Page with before = the previous answer's nextBefore.",
      inputSchema: z.object({
        workspace: workspaceArg,
        filter: z.enum(ACTIVITY_FILTERS).optional().describe("Only one kind of event."),
        repository: z.string().optional().describe("Only this repository (owner/name)."),
        result: z.enum(ACTIVITY_RESULTS).optional(),
        machine: z.string().optional().describe("Only this machine, by id."),
        since: z.string().datetime().optional().describe("Only events after this ISO time."),
        before: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(50).default(15).describe("Entries to return (1-50)."),
        detail: z.boolean().default(false).describe("Return full entries instead of compact ones."),
      }),
      annotations: READ_ONLY,
    },
    ({ workspace, since, limit, detail, ...query }) =>
      answer(async () => {
        const page = await scoped(workspace)<ActivityPage>("/activity", {
          ...query,
          since: since ? Date.parse(since) : undefined,
        });
        return compactActivityPage(page, limit, detail);
      }),
  );

  server.registerTool(
    "get_usage",
    {
      title: "Usage",
      description:
        "What the workspace's CI used and saved: jobs under a minute and what GitHub's round-up to whole minutes cost, what optimized checks saved, and each connected GitHub account's Actions minutes this billing cycle (an org in a GitHub enterprise shows its enterprise's shared minutes, named by `enterprise`).",
      inputSchema: z.object({ workspace: workspaceArg, days: days(90, 30) }),
      annotations: READ_ONLY,
    },
    ({ workspace, days }) =>
      answer(async () => {
        const api = scoped(workspace);
        const [jobs, checks, actions] = await Promise.all([
          api("/usage", { days }),
          api("/usage/checks", { days }),
          api("/usage/actions"),
        ]);
        return { jobs, checks, actions };
      }),
  );

  server.registerTool(
    "get_job_times",
    {
      title: "Job times",
      description:
        "How long each job usually takes on each runner environment, for comparing machines against GitHub-hosted runners: median and p90 run time, median wait for a runner, and the trend against the window before (0.18 is 18% slower). When AI is on for the workspace, a job also has `type`: lint, test, e2e, build, deploy or other. Times with no successful runs behind them are left out. Narrow with repository and workflow to keep the answer small.",
      inputSchema: z.object({
        workspace: workspaceArg,
        days: days(30, 14),
        repository: z
          .string()
          .optional()
          .describe("Only workflows in repositories whose owner/name contains this."),
        workflow: z.string().optional().describe("Only workflows whose name contains this."),
      }),
      annotations: READ_ONLY,
    },
    ({ workspace, days, ...filter }) =>
      answer(async () => compactJobTimes(await scoped(workspace)("/job-times", { days }), filter)),
  );

  server.registerTool(
    "get_signals",
    {
      title: "Signals",
      description:
        "What's making the workspace's CI slow, costly or busier than it needs to be, such as queue waits, flaky jobs, runner failures, short jobs or runs that kept going after a newer push. Each signal has an id, an area (speed, cost or complexity), its jobs, minutes and estimated cost, and the repos and workflows it affects most. Only signals over 30 minutes and 1% of all job minutes show. A person, repository, workflow, branch, trigger or changed folder narrows everything to those runs over at most 30 days and adds their minutes per day against the days before.",
      inputSchema: z.object({
        workspace: workspaceArg,
        days: days(90, 30),
        breakdown: z
          .boolean()
          .default(false)
          .describe(
            "Also return minutes and cost by person, repository, workflow, branch and trigger, and pull request runs by the folders they changed (path; a run counts under each folder, and / is files at the root).",
          ),
        person: z.string().optional().describe("Only runs this GitHub login started."),
        repository: z.string().optional().describe("Only this repo, as owner/name."),
        workflow: z
          .string()
          .optional()
          .describe("Only this workflow, by name. Pass its repository too."),
        branch: z.string().optional().describe("Only runs on this branch."),
        trigger: z
          .string()
          .optional()
          .describe('Only runs from this event, such as push or pull_request, or "rerun".'),
        path: z
          .string()
          .optional()
          .describe(
            "Only pull request runs that changed this folder, such as apps/web or docs, as the path breakdown names it. Pass its repository too.",
          ),
      }),
      annotations: READ_ONLY,
    },
    ({ workspace, days, breakdown, repository, ...filter }) =>
      answer(() =>
        scoped(workspace)("/signals", {
          days,
          breakdown: breakdown ? undefined : 0,
          repo: repository,
          ...filter,
        }),
      ),
  );

  server.registerTool(
    "send_feedback",
    {
      title: "Send feedback",
      description:
        "Tell the RelayRunner team about a problem: a tool that errors or answers something that looks wrong, a result that's confusing, or something the person needs that no tool does. Say what you called, what you expected and what happened. Leave out secrets, tokens and personal data (anything that looks like a credential is redacted anyway). It's stored and emailed to the team, who may reply to the person; up to 10 an hour.",
      inputSchema: z.object({
        category: z
          .enum(FEEDBACK_CATEGORIES)
          .describe(
            "bug, confusing (a result or description was unclear), feature_request or other.",
          ),
        summary: z
          .string()
          .min(1)
          .max(FEEDBACK_LIMITS.summary)
          .describe("One line: what went wrong or what's missing."),
        details: z
          .string()
          .max(FEEDBACK_LIMITS.details)
          .optional()
          .describe("What you called, with which arguments, what you expected and what you got."),
        tool: z
          .string()
          .max(FEEDBACK_LIMITS.tool)
          .optional()
          .describe("The tool this is about, if any."),
        workspace: workspaceArg,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ workspace, ...feedback }) =>
      answer(async () => {
        // Optional here: feedback isn't always about one workspace. The API falls back to the
        // connection's only one.
        const id = workspace ? workspaceId(workspace) : undefined;
        // Never repeat the text back: only that it arrived.
        const { id: feedbackId, redacted } = await request<{ id: string; redacted: number }>(
          "/feedback",
          { workspaceId: id, body: feedback },
        );
        return {
          received: true,
          id: feedbackId,
          ...(redacted > 0 && {
            note: `${redacted} secret-like value(s) were redacted before saving.`,
          }),
        };
      }),
  );
}
