import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ACTIVITY_FILTERS, ACTIVITY_RESULTS, type ActivityPage } from "@relayrunner/activity";
import { z } from "zod";
import { ApiError, type Api, type Me } from "./api.ts";
import { compactActivityPage, compactJobTimes } from "./compact.ts";

// Read-only tools over relayrunner-api's dashboard endpoints, all D1 reads. Each answers JSON.
// None asks GitHub or takes the Router's lock (apps/api/src/agent-auth.ts keeps it that way).

// Avatars and dashboard-only permissions aren't useful to an agent.
const DASHBOARD_ONLY = new Set(["ownerImage", "canRevoke", "mine"]);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

// Unindented: every byte counts against the client's tool-result cap.
function json(value: unknown): Result {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// API errors come back as tool errors the model can read and act on, not protocol errors.
async function answer(read: () => Promise<unknown>): Promise<Result> {
  try {
    return json(await read());
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

const days = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Days to look back (1-${max}).`);

export function registerTools(server: McpServer, api: Api, me: Me) {
  server.registerTool(
    "get_workspace",
    {
      title: "Workspace",
      description:
        "The RelayRunner workspace this connection can read: its name, your role in it, and the GitHub accounts (orgs or users) connected to it.",
      annotations: READ_ONLY,
    },
    () => answer(() => api("/workspaces/current")),
  );

  server.registerTool(
    "list_runners",
    {
      title: "Runners",
      description:
        "Every runner in the workspace: machines connected with the RelayRunner CLI and self-hosted runners added from GitHub. Each has its labels, whether it's online, idle or busy (and the job it's running), whether it's paused, and whose jobs it takes. Runners added from GitHub show github.unreachable because this tool doesn't ask GitHub for their live status; check the dashboard for that.",
      annotations: READ_ONLY,
    },
    () =>
      answer(async () => {
        const { machines } = await api<{ machines: Record<string, unknown>[] }>("/machines");
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
        "The workspace's runner order: the providers RelayRunner tries for a job, top to bottom ('machine' for connected machines, 'github' for GitHub-hosted runners, optionally with a monthly minutes limit, and 'blacksmith'). A job goes to the first provider it allows that can take it. isDefault is true when nobody has changed it.",
      annotations: READ_ONLY,
    },
    () => answer(() => api(`/workspaces/${encodeURIComponent(me.agent.workspaceId)}/runner-order`)),
  );

  server.registerTool(
    "list_runs",
    {
      title: "Workflow runs",
      description:
        "Recent workflow runs (last 14 days), newest first: repository, workflow, branch, status, conclusion, wall time against the workflow's usual time, where its jobs ran, and whether RelayRunner routed it. Use get_run_jobs for one run's jobs and list_activity for why a job went where it did.",
      inputSchema: {
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
    ({ repository, status, conclusion, routed, limit }) =>
      answer(async () => {
        const report = await api<{ runs: Record<string, unknown>[]; truncated: boolean }>("/runs");
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
        repositoryId: z.number().int().positive(),
        runId: z.number().int().positive(),
        runAttempt: z.number().int().positive().default(1),
      },
      annotations: READ_ONLY,
    },
    ({ repositoryId, runId, runAttempt }) =>
      answer(() => api(`/runs/${repositoryId}/${runId}/${runAttempt}/jobs`)),
  );

  server.registerTool(
    "list_activity",
    {
      title: "Activity",
      description:
        "The workspace's activity log, newest first: jobs (where RelayRunner routed each one, which providers it skipped and why), free checks, machines connecting, pausing or going offline, and member changes. Items are compact (type, time, repo, job, runner, conclusion, route step and skipped reasons); pass detail for urls, sha, who started each run and the route's label inputs. Page with before = the previous answer's nextBefore.",
      inputSchema: {
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
    ({ since, limit, detail, ...query }) =>
      answer(async () => {
        const page = await api<ActivityPage>("/activity", {
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
      inputSchema: { days: days(90, 30) },
      annotations: READ_ONLY,
    },
    ({ days }) =>
      answer(async () => {
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
        days: days(30, 14),
        repository: z
          .string()
          .optional()
          .describe("Only workflows in repositories whose owner/name contains this."),
        workflow: z.string().optional().describe("Only workflows whose name contains this."),
      },
      annotations: READ_ONLY,
    },
    ({ days, ...filter }) =>
      answer(async () => compactJobTimes(await api("/job-times", { days }), filter)),
  );
}
