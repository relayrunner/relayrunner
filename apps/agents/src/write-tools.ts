import type { McpServer } from "@modelcontextprotocol/server";
import { AUTO_SIZE_MESSAGE, isAutoSize } from "@relayrunner/providers";
import {
  RETRY_RUNNERS,
  RUNNER_KEYS,
  type RetrySettings,
  runnerStepSchema,
} from "@relayrunner/runner-order";
import { z } from "zod";
import { answer, findNamed, repositoryArg, type ToolContext, workspaceArg } from "./context.ts";

// Tools that change a workspace's routing settings, each through the same API route the dashboard
// uses, so the API checks the person's role and logs the change in Activity with the agent's name.
// They work only where the person turned on Allow changes for this agent in Settings →
// Agents (apps/api/src/agent-auth.ts); elsewhere the API answers AGENT_CHANGES_OFF. Each answers
// the new value and the one it replaced (`previous`), so a change can be undone.

// Clients ask before running a tool that isn't read-only or is destructive.
const CHANGES = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const sizeArg = z.number().int().refine(isAutoSize, { message: AUTO_SIZE_MESSAGE });

const ALLOW_CHANGES =
  "Needs Allow changes for this agent in the workspace (see list_workspaces' canWrite), and works only where the person could make the change in the dashboard.";

export function registerWriteTools(server: McpServer, context: ToolContext) {
  const { request, workspaceId, workspacePath: route } = context;
  const put = <T>(
    workspace: string | undefined,
    path: string,
    body: unknown,
    query?: Record<string, string | undefined>,
  ) => request<T>(route(workspace, path), { method: "PUT", body, query });

  server.registerTool(
    "get_router_settings",
    {
      title: "Router settings",
      description:
        "The workspace's settings beside the runner order: the default size (vCPUs) for auto jobs, each auto job (a relay that lets RelayRunner pick its runner) with its own size, the provider it tries first (null is the default) and whether you may change it (canEdit), automatic retries of jobs a runner failed, and whether AI features are on.",
      inputSchema: z.object({ workspace: workspaceArg }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ workspace }) =>
      answer(async () => {
        const [auto, retries, ai] = await Promise.all([
          request<{ size: number; jobs: unknown[] }>(route(workspace, "auto-jobs")),
          request<RetrySettings>(route(workspace, "retry-settings")),
          request<{ offAt: string | null }>(route(workspace, "ai")),
        ]);
        return { defaultSize: auto.size, jobs: auto.jobs, retries, ai: { enabled: !ai.offAt } };
      }),
  );

  server.registerTool(
    "set_runner_order",
    {
      title: "Set runner order",
      description: `Replaces the workspace's runner order with \`steps\`, top to bottom, or with \`repository\` gives that repository its own order (repositories with their own keep it when the workspace's changes). Read it first with get_runner_order (with the same \`repository\`) and pass its \`version\`: if someone changed it since, this fails and you read it again. A provider left out never gets jobs. Answers the new order, its version and the previous order. The workspace's order needs an owner or admin; a repository's, also anyone who can push to it. ${ALLOW_CHANGES}`,
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: repositoryArg,
        version: z.string().describe("The version get_runner_order answered."),
        steps: z
          .array(runnerStepSchema)
          .min(1)
          .describe(
            "Each provider once, except 'github', which may come twice: once with a limit (percent of included minutes) and once without. spendLimit (whole dollars a month) only for hosted providers with list prices.",
          ),
      }),
      annotations: CHANGES,
    },
    ({ workspace, repository, version, steps }) =>
      answer(() => put(workspace, "runner-order", { steps, version }, { repo: repository })),
  );

  server.registerTool(
    "use_workspace_order",
    {
      title: "Use the workspace order",
      description: `Puts a repository with its own runner order back on the workspace's: its jobs walk the workspace's order again. Answers the order it walks now and the one it had. Who may: as set_runner_order for that repository. ${ALLOW_CHANGES}`,
      inputSchema: z.object({
        workspace: workspaceArg,
        repository: z.string().describe("The repository, as owner/name."),
      }),
      annotations: CHANGES,
    },
    ({ workspace, repository }) =>
      answer(() =>
        request(route(workspace, "runner-order"), {
          method: "DELETE",
          query: { repo: repository },
        }),
      ),
  );

  server.registerTool(
    "set_default_size",
    {
      title: "Set default size",
      description: `Sets the size, in vCPUs, that auto jobs run at unless they have their own (set_job_size). ${ALLOW_CHANGES}`,
      inputSchema: z.object({ workspace: workspaceArg, size: sizeArg.describe("vCPUs.") }),
      annotations: CHANGES,
    },
    ({ workspace, size }) => answer(() => put(workspace, "auto-size", { size })),
  );

  server.registerTool(
    "set_job_size",
    {
      title: "Set job size",
      description: `Sets one auto job's size and the provider it tries first, by its id from get_router_settings. Leave one out to keep it; null puts it back on the default. Works for owners and admins, and for anyone who can push to the job's repo. ${ALLOW_CHANGES}`,
      inputSchema: z.object({
        workspace: workspaceArg,
        job: z.number().int().describe("The auto job's id."),
        size: sizeArg.nullable().optional().describe("vCPUs, or null for the default size."),
        first: z
          .enum(RUNNER_KEYS)
          .nullable()
          .optional()
          .describe("The provider to try first, or null to follow the runner order."),
      }),
      annotations: CHANGES,
    },
    // The API keeps what's left out.
    ({ workspace, job, size, first }) =>
      answer(() => put(workspace, `auto-jobs/${job}`, { size, first })),
  );

  server.registerTool(
    "set_retries",
    {
      title: "Set automatic retries",
      description: `Turns automatic retries on or off: a job is re-run once its run finishes when its runner failed it, such as a machine going offline mid-job, but not when the job's own steps failed. Leave runner or max out to keep them. ${ALLOW_CHANGES}`,
      inputSchema: z.object({
        workspace: workspaceArg,
        enabled: z.boolean(),
        runner: z
          .enum(RETRY_RUNNERS)
          .optional()
          .describe("Where the retry goes: any runner, the same one, or another one."),
        max: z.number().int().min(1).max(2).optional().describe("Retries per run, 1 or 2."),
      }),
      annotations: CHANGES,
    },
    ({ workspace, ...settings }) => answer(() => put(workspace, "retry-settings", settings)),
  );

  server.registerTool(
    "set_ai",
    {
      title: "Turn AI on or off",
      description: `Turns the workspace's AI features on or off (job types, failure causes, smart retries). Turning them off also deletes the AI answers saved so far. ${ALLOW_CHANGES}`,
      inputSchema: z.object({ workspace: workspaceArg, enabled: z.boolean() }),
      annotations: CHANGES,
    },
    ({ workspace, enabled }) => answer(() => put(workspace, "ai", { enabled })),
  );

  // Pausing is global: every workspace stops routing to the machine. Only its owner may pause a
  // connected machine; owners and admins may pause a runner added from GitHub.
  const runnerArg = z.object({
    workspace: workspaceArg,
    runner: z.string().describe("The runner's id or name, from list_runners."),
  });
  const setPaused =
    (action: "pause" | "resume") =>
    ({ workspace, runner }: z.infer<typeof runnerArg>) =>
      answer(async () => {
        const id = workspaceId(workspace);
        const { machines } = await request<{ machines: { id: string; name: string }[] }>(
          "/machines",
          { workspaceId: id },
        );
        const named = findNamed(machines, runner, { noun: "runner", listTool: "list_runners" });
        const { machine } = await request<{ machine: Record<string, unknown> }>(
          `/machines/${encodeURIComponent(named.id)}/${action}`,
          { workspaceId: id, body: {} },
        );
        return { runner: { id: machine.id, name: machine.name, paused: machine.paused } };
      });

  server.registerTool(
    "pause_runner",
    {
      title: "Pause runner",
      description: `Pauses a runner: it stays connected, but no job routes to it, in any workspace, until it's resumed. A job it's running carries on. Only its owner can pause a connected machine; owners and admins can pause a runner added from GitHub. ${ALLOW_CHANGES}`,
      inputSchema: runnerArg,
      annotations: CHANGES,
    },
    setPaused("pause"),
  );

  server.registerTool(
    "resume_runner",
    {
      title: "Resume runner",
      description: `Resumes a paused runner, so jobs route to it again. ${ALLOW_CHANGES}`,
      inputSchema: runnerArg,
      annotations: CHANGES,
    },
    setPaused("resume"),
  );
}
