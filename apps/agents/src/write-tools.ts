import { AppError } from "@relayrunner/errors";
import type { McpServer } from "@modelcontextprotocol/server";
import { AUTO_SIZES } from "@relayrunner/providers";
import {
  RETRY_RUNNERS,
  RUNNER_KEYS,
  type RetrySettings,
  runnerStepSchema,
} from "@relayrunner/runner-order";
import { z } from "zod";
import type { WorkspaceApi } from "./api.ts";
import { answer, workspaceArg } from "./tools.ts";

// Tools that change a workspace's routing settings, each through the same API route the dashboard
// uses, so the API checks the person's role and logs the change in Activity with the agent's name.
// They work only where an owner or admin turned on Allow changes for this agent in Settings →
// Agents (apps/api/src/agent-auth.ts); elsewhere the API answers AGENT_CHANGES_OFF. Each answers
// the new value and the one it replaced (`previous`), so a change can be undone.

// Clients ask before running a tool that isn't read-only or is destructive.
const CHANGES = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const sizeArg = z
  .number()
  .int()
  .refine((size) => (AUTO_SIZES as readonly number[]).includes(size), {
    message: `Pick ${AUTO_SIZES.join(", ")}.`,
  });

const ALLOW_CHANGES =
  "Needs Allow changes for this agent in the workspace (see list_workspaces' canWrite) and an owner or admin role.";

interface AutoJobs {
  size: number;
  jobs: { id: number; size: number | null; first: string | null }[];
}

export function registerWriteTools(
  server: McpServer,
  request: WorkspaceApi,
  workspaceId: (workspace: string | undefined) => string,
) {
  const route = (workspace: string | undefined, path: string) =>
    `/workspaces/${encodeURIComponent(workspaceId(workspace))}/${path}`;
  const put = <T>(workspace: string | undefined, path: string, body: unknown) =>
    request<T>(route(workspace, path), { method: "PUT", body });

  server.registerTool(
    "get_router_settings",
    {
      title: "Router settings",
      description:
        "The workspace's settings beside the runner order: the default size (vCPUs) for auto jobs, each auto job (a relay that lets RelayRunner pick its runner) with its own size and the provider it tries first (null is the default), automatic retries of jobs a runner failed, and whether AI features are on.",
      inputSchema: z.object({ workspace: workspaceArg }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ workspace }) =>
      answer(async () => {
        const [auto, retries, ai] = await Promise.all([
          request<AutoJobs>(route(workspace, "auto-jobs")),
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
      description: `Replaces the workspace's runner order with \`steps\`, top to bottom. Read it first with get_runner_order and pass its \`version\`: if someone changed it since, this fails and you read it again. A provider left out never gets jobs. Answers the new order, its version and the previous order. ${ALLOW_CHANGES}`,
      inputSchema: z.object({
        workspace: workspaceArg,
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
    ({ workspace, version, steps }) =>
      answer(() => put(workspace, "runner-order", { steps, version })),
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
      description: `Sets one auto job's size and the provider it tries first, by its id from get_router_settings. Leave one out to keep it; null puts it back on the default. ${ALLOW_CHANGES}`,
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
    ({ workspace, job, size, first }) =>
      answer(async () => {
        const { jobs } = await request<AutoJobs>(route(workspace, "auto-jobs"));
        const current = jobs.find((row) => row.id === job);
        if (!current) {
          throw new AppError("NOT_FOUND", {
            message: `No auto job ${job} in the last 30 days. See get_router_settings.`,
          });
        }
        return put(workspace, `auto-jobs/${job}`, {
          size: size === undefined ? current.size : size,
          first: first === undefined ? current.first : first,
        });
      }),
  );

  server.registerTool(
    "set_retries",
    {
      title: "Set automatic retries",
      description: `Turns automatic retries on or off: RelayRunner re-runs a job once its run finishes when its runner failed it, such as a machine going offline mid-job, but not when the job's own steps failed. Leave runner or max out to keep them. ${ALLOW_CHANGES}`,
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
    ({ workspace, enabled, runner, max }) =>
      answer(async () => {
        const current = await request<RetrySettings>(route(workspace, "retry-settings"));
        return put(workspace, "retry-settings", {
          enabled,
          runner: runner ?? current.runner,
          max: max ?? current.max,
        });
      }),
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
  for (const paused of [true, false]) {
    const action = paused ? "pause" : "resume";
    server.registerTool(
      `${action}_runner`,
      {
        title: paused ? "Pause runner" : "Resume runner",
        description: paused
          ? `Pauses a runner, by id or name from list_runners: it stays connected, but no job routes to it, in any workspace, until it's resumed. A job it's running carries on. Only its owner can pause a connected machine; owners and admins can pause a runner added from GitHub. ${ALLOW_CHANGES}`
          : `Resumes a paused runner, by id or name from list_runners, so jobs route to it again. ${ALLOW_CHANGES}`,
        inputSchema: z.object({
          workspace: workspaceArg,
          runner: z.string().describe("The runner's id or name."),
        }),
        annotations: CHANGES,
      },
      ({ workspace, runner }) =>
        answer(async () => {
          const id = workspaceId(workspace);
          const { machines } = await request<{ machines: { id: string; name: string }[] }>(
            "/machines",
            { workspaceId: id },
          );
          const named = machines.filter(
            (machine) =>
              machine.id === runner || machine.name.toLowerCase() === runner.toLowerCase(),
          );
          if (named.length !== 1) {
            throw new AppError("NOT_FOUND", {
              message:
                named.length === 0
                  ? `No runner "${runner}" in this workspace. See list_runners.`
                  : `Several runners are named "${runner}". Pass its id from list_runners.`,
            });
          }
          const { machine } = await request<{ machine: Record<string, unknown> }>(
            `/machines/${encodeURIComponent(named[0].id)}/${action}`,
            { workspaceId: id, body: {} },
          );
          return { runner: { id: machine.id, name: machine.name, paused: machine.paused } };
        }),
    );
  }
}
