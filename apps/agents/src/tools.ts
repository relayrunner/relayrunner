import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACTIVITY_FILTERS,
  ACTIVITY_RESULTS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_LIMITS,
  type ActivityPage,
} from "@relayrunner/activity";
import { z } from "zod";
import { ApiError, type Api, type Workspace, type WorkspaceApi } from "./api.ts";
import { compactActivityPage, compactJobTimes } from "./compact.ts";

// Read-only tools over relayrunner-api's dashboard endpoints, all D1 reads, plus send_feedback,
// which only records a report for the RelayRunner team. Each answers JSON. None asks GitHub or
// takes the Router's lock (apps/api/src/agent-auth.ts keeps it that way).

// Avatars and dashboard-only permissions aren't useful to an agent.
const DASHBOARD_ONLY = new Set(["ownerImage", "canRevoke", "mine"]);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

// Unindented: every byte counts against the client's tool-result cap.
function json(value: unknown): Result {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// A call the model can fix itself, such as naming a workspace.
class ToolError extends Error {}

// API errors come back as tool errors the model can read and act on, not protocol errors.
async function answer(read: () => Promise<unknown>): Promise<Result> {
  try {
    return json(await read());
  } catch (error) {
    if (!(error instanceof ApiError || error instanceof ToolError)) throw error;
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

const workspaceArg = z
  .string()
  .optional()
  .describe(
    "Which workspace, by id or name (see list_workspaces). Needed only when this connection reads more than one.",
  );

const days = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Days to look back (1-${max}).`);

export function registerTools(server: McpServer, request: WorkspaceApi, workspaces: Workspace[]) {
  // The workspace a call names (by id or name), or the connection's only one.
  function workspaceId(workspace: string | undefined) {
    if (!workspace) {
      if (workspaces.length === 1) return workspaces[0].id;
      throw new ToolError(
        `This connection reads ${workspaces.length} workspaces. Pass workspace (an id or name from list_workspaces).`,
      );
    }
    const named = workspaces.find(
      ({ id, name }) => id === workspace || name.toLowerCase() === workspace.toLowerCase(),
    );
    if (!named) {
      throw new ToolError(`No workspace "${workspace}" on this connection. See list_workspaces.`);
    }
    return named.id;
  }

  // The API, about the workspace a call names.
  const scoped =
    (workspace: string | undefined): Api =>
    (path, query) =>
      request(path, { query, workspaceId: workspaceId(workspace) });

  server.registerTool(
    "list_workspaces",
    {
      title: "Workspaces",
      description:
        "The RelayRunner workspaces this connection can read, by id and name. Pass one as `workspace` to the other tools; get_workspace has your role and GitHub accounts in each.",
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
      inputSchema: { workspace: workspaceArg },
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
      inputSchema: { workspace: workspaceArg },
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
        "The workspace's runner order: the providers RelayRunner tries for a job, top to bottom ('machine' for connected machines, 'github' for GitHub-hosted runners, optionally with a monthly minutes limit, and hosted providers by id: 'blacksmith', 'depot', 'namespace', 'warpbuild', 'ubicloud', 'runs-on'). A job goes to the first provider it allows that can take it. isDefault is true when nobody has changed it.",
      inputSchema: { workspace: workspaceArg },
      annotations: READ_ONLY,
    },
    ({ workspace }) =>
      answer(async () => {
        const id = workspaceId(workspace);
        return request(`/workspaces/${encodeURIComponent(id)}/runner-order`);
      }),
  );

  server.registerTool(
    "list_runs",
    {
      title: "Workflow runs",
      description:
        "Recent workflow runs (last 14 days), newest first: repository, workflow, branch, status, conclusion, wall time against the workflow's usual time, where its jobs ran, and whether RelayRunner routed it. Use get_run_jobs for one run's jobs and list_activity for why a job went where it did.",
      inputSchema: {
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
      },
      annotations: READ_ONLY,
    },
    ({ workspace, repository, status, conclusion, routed, limit }) =>
      answer(async () => {
        const report = await scoped(workspace)<{
          runs: Record<string, unknown>[];
          truncated: boolean;
        }>("/runs");
        const runs = report.runs.filter(
          (run) =>
            (!repository ||
              String(run.repository).toLowerCase().includes(repository.toLowerCase())) &&
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
      inputSchema: {
        workspace: workspaceArg,
        repositoryId: z.number().int().positive(),
        runId: z.number().int().positive(),
        runAttempt: z.number().int().positive().default(1),
      },
      annotations: READ_ONLY,
    },
    ({ workspace, repositoryId, runId, runAttempt }) =>
      answer(() => scoped(workspace)(`/runs/${repositoryId}/${runId}/${runAttempt}/jobs`)),
  );

  server.registerTool(
    "list_activity",
    {
      title: "Activity",
      description:
        "The workspace's activity log, newest first: jobs (where RelayRunner routed each one, which providers it skipped and why), free checks, machines connecting, pausing or going offline, and member changes. Items are compact (type, time, repo, job, runner, conclusion, route step and skipped reasons); pass detail for urls, sha, who started each run and the route's label inputs. Page with before = the previous answer's nextBefore.",
      inputSchema: {
        workspace: workspaceArg,
        filter: z.enum(ACTIVITY_FILTERS).optional().describe("Only one kind of event."),
        repository: z.string().optional().describe("Only this repository (owner/name)."),
        result: z.enum(ACTIVITY_RESULTS).optional(),
        machine: z.string().optional().describe("Only this machine, by id."),
        since: z.string().datetime().optional().describe("Only events after this ISO time."),
        before: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(50).default(15).describe("Entries to return (1-50)."),
        detail: z.boolean().default(false).describe("Return full entries instead of compact ones."),
      },
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
        "What the workspace's CI used and saved: jobs under a minute and what GitHub's round-up to whole minutes cost, what free checks saved, and each connected GitHub account's Actions minutes this billing cycle.",
      inputSchema: { workspace: workspaceArg, days: days(90, 30) },
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
        "How long each workflow and job usually takes on each runner environment, for comparing machines against GitHub-hosted runners. Times with no successful runs behind them are left out. Narrow with repository and workflow to keep the answer small.",
      inputSchema: {
        workspace: workspaceArg,
        days: days(30, 14),
        repository: z
          .string()
          .optional()
          .describe("Only workflows in repositories whose owner/name contains this."),
        workflow: z.string().optional().describe("Only workflows whose name contains this."),
      },
      annotations: READ_ONLY,
    },
    ({ workspace, days, ...filter }) =>
      answer(async () => compactJobTimes(await scoped(workspace)("/job-times", { days }), filter)),
  );

  server.registerTool(
    "send_feedback",
    {
      title: "Send feedback",
      description:
        "Tell the RelayRunner team about a problem: a tool that errors or answers something that looks wrong, a result that's confusing, or something the person needs that no tool does. Say what you called, what you expected and what happened. Leave out secrets, tokens and personal data (anything that looks like a credential is redacted anyway). It's stored and emailed to the team, who may reply to the person; up to 10 an hour.",
      inputSchema: {
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
      },
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
