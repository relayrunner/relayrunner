/*
 * The OpenAPI description of the agent API, served at /openapi.json. These are the routes an
 * agent's OAuth token may call on https://api.relayrunner.dev (AGENT_ROUTES_BY_METHOD in
 * apps/api/src/auth/agent-auth.ts); the MCP server's tools call the same routes. A test in
 * apps/api/src/agent-openapi.test.ts keeps the two lists in step.
 *
 * Response bodies are described at the top level only: the fields inside them are the dashboard's
 * and change with it.
 */
import {
  ACTIVITY_FILTERS,
  ACTIVITY_RESULTS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_LIMITS,
} from "@relayrunner/activity";
import {
  AGENT_FILTERS,
  BREAKDOWN_BY,
  BREAKDOWN_DEFAULT_ROWS,
  BREAKDOWN_MAX_ROWS,
  BREAKDOWN_SORTS,
  MAX_UTC_OFFSET_MINUTES,
  PULL_REQUEST_MAX_PAGE,
  PULL_REQUEST_PAGE,
  PULL_REQUEST_SORTS,
  RAW_RETENTION_DAYS,
  RUN_FILTER_HELP,
  RUN_FILTER_KEYS,
} from "@relayrunner/api-types";
import { ERRORS } from "@relayrunner/errors";
import { AUTO_SIZES } from "@relayrunner/providers";
import { RETRY_RUNNERS, RUNNER_KEYS } from "@relayrunner/runner-order";
import { MCP_URL } from "./mcp";

const AUTH = "https://app.relayrunner.dev/api/auth";

const workspaceHeader = {
  name: "x-relayrunner-workspace",
  in: "header",
  required: false,
  description:
    "The workspace to read, by id. Needed only when the token's grant covers more than one workspace.",
  schema: { type: "string" },
};

const daysQuery = (max: number, fallback: number) => ({
  name: "days",
  in: "query",
  required: false,
  description: `How many days back to look (1 to ${max}).`,
  schema: { type: "integer", minimum: 1, maximum: max, default: fallback },
});

const stringQuery = (name: string, description: string, extra: object = {}) => ({
  name,
  in: "query",
  required: false,
  description,
  schema: { type: "string", ...extra },
});

// Who and what started the runs a report counts, matched exactly.
const runFilterQueries = RUN_FILTER_KEYS.map((key) =>
  stringQuery(key, RUN_FILTER_HELP[key], key === "agent" ? { enum: AGENT_FILTERS } : {}),
);

const providerPath = {
  name: "provider",
  in: "path",
  required: true,
  description: "A provider's id, such as github, machine or blacksmith.",
  schema: { type: "string" },
};

/** A JSON object response whose listed fields are always there. */
const object = (description: string, properties: Record<string, object> = {}) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties,
        required: Object.keys(properties),
      },
    },
  },
});

const list = { type: "array", items: { type: "object" } };
const record = { type: "object" };

const errors = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "429": { $ref: "#/components/responses/Error" },
};

const read = (
  operationId: string,
  summary: string,
  description: string,
  ok: object,
  parameters: object[] = [],
): object => ({
  get: {
    operationId,
    summary,
    description,
    parameters: [workspaceHeader, ...parameters],
    responses: { "200": ok, ...errors },
  },
});

const workspacePath = {
  name: "workspaceId",
  in: "path",
  required: true,
  schema: { type: "string" },
};

const repoQuery = {
  name: "repo",
  in: "query",
  required: false,
  description: "A repository in the workspace, as owner/name, for its own runner order.",
  schema: { type: "string" },
};

/**
 * A route that changes a setting. It works only where the person allowed the agent changes, and
 * only for a change they could make in the dashboard; it's logged in the workspace's Activity.
 */
const change = (
  operationId: string,
  summary: string,
  description: string,
  body: Record<string, object>,
  ok: object,
  {
    parameters = [workspacePath],
    method = "put",
    required = Object.keys(body),
  }: { parameters?: object[]; method?: string; required?: string[] } = {},
): object => ({
  [method]: {
    operationId,
    summary,
    description: `${description} Needs Allow changes for the agent in the workspace (Settings › Agents); otherwise 403 AGENT_CHANGES_OFF. Logged in Activity.`,
    parameters: [workspaceHeader, ...parameters],
    ...(Object.keys(body).length > 0 && {
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { type: "object", properties: body, required } },
        },
      },
    }),
    responses: { "200": ok, ...errors, "409": { $ref: "#/components/responses/Error" } },
  },
});

const autoSize = { type: "integer", enum: AUTO_SIZES };

export const openApi = {
  openapi: "3.1.0",
  info: {
    title: "RelayRunner API",
    version: "1.0.0",
    summary:
      "Read a workspace's runners, workflow runs, routing activity and CI usage, and change its routing.",
    description: `The API behind the RelayRunner MCP server: a workspace's runners, runs, routing and usage. Sign in with OAuth (the \`workspace:read\` scope): the person picks which workspaces the token may read. The routes that change settings work only in workspaces where the person turned on Allow changes for the connection in Settings › Agents. To connect an AI agent, use the MCP server at ${MCP_URL} instead: MCP clients sign in on their own and get these routes as tools. Call this API directly only from your own OAuth client. Each connection can make 300 requests a minute; past that the API answers 429.`,
    contact: { url: "https://github.com/relayrunner/relayrunner/issues" },
    license: { name: "Apache-2.0", identifier: "Apache-2.0" },
  },
  externalDocs: { url: "https://relayrunner.dev/docs/reference/api" },
  servers: [{ url: "https://api.relayrunner.dev/api" }],
  security: [{ oauth: ["workspace:read"] }],
  paths: {
    "/me": read(
      "getMe",
      "Get the current user",
      "The signed-in user and the workspaces this token may read.",
      object("The user and the token's grant.", { user: record, agent: record }),
    ),
    "/workspaces/current": read(
      "getWorkspace",
      "Get a workspace",
      "One workspace, your role in it and its connected GitHub accounts.",
      object("The workspace.", {
        workspace: record,
        role: { type: "string" },
        installations: list,
      }),
    ),
    "/workspaces/{workspaceId}/runner-order": {
      ...read(
        "getRunnerOrder",
        "Get the runner order",
        "The providers jobs are tried on, top to bottom. With `repo`, the order that repo's jobs walk: its own (`scope` is `repository`) or the workspace's. Without it, `ownOrders` lists the repos with their own. `version` changes whenever the order does.",
        object("The runner order.", {
          order: record,
          scope: { type: "string", enum: ["workspace", "repository"] },
          isDefault: { type: "boolean" },
          version: { type: "string" },
        }),
        [workspacePath, repoQuery],
      ),
      ...change(
        "setRunnerOrder",
        "Set the runner order",
        "Replaces the workspace's runner order, or with `repo` gives that repo its own, which it keeps when the workspace's changes. With `version`, it fails with 409 RUNNER_ORDER_CHANGED if the order changed since that version was read. The workspace's order needs an owner or admin; a repo's, also anyone who can push to it on GitHub.",
        { steps: list, version: { type: "string" } },
        object("The new order and the one it replaced.", {
          order: record,
          version: { type: "string" },
          previous: record,
        }),
        { required: ["steps"], parameters: [workspacePath, repoQuery] },
      ),
      ...change(
        "useWorkspaceOrder",
        "Use the workspace's runner order",
        "Puts `repo` back on the workspace's runner order. The same people as setting the repo's order.",
        {},
        object("The order the repo walks now and the one it had.", {
          order: record,
          previous: record,
        }),
        { method: "delete", parameters: [workspacePath, { ...repoQuery, required: true }] },
      ),
    },
    "/workspaces/{workspaceId}/auto-jobs": read(
      "listAutoJobs",
      "List auto jobs",
      "Jobs whose relay lets RelayRunner pick the runner, from the last 30 days, with each one's size and first provider (null is the default) and whether you may change it (`canEdit`), and the default size.",
      object("The default size and the auto jobs.", { size: { type: "integer" }, jobs: list }),
      [workspacePath],
    ),
    "/workspaces/{workspaceId}/auto-jobs/{jobId}": change(
      "setJobSize",
      "Set a job's size",
      "One auto job's size in vCPUs and the provider it tries first. Null puts either back on the default; one left out stays as it is. Owners and admins can change any job, and anyone who can push to the job's repo on GitHub can change its jobs.",
      {
        size: { type: ["integer", "null"], enum: [...AUTO_SIZES, null] },
        first: { type: ["string", "null"], enum: [...RUNNER_KEYS, null] },
      },
      object("The new setting and the one it replaced.", { previous: record }),
      {
        required: [],
        parameters: [
          workspacePath,
          { name: "jobId", in: "path", required: true, schema: { type: "integer" } },
        ],
      },
    ),
    "/workspaces/{workspaceId}/auto-size": change(
      "setDefaultSize",
      "Set the default size",
      "The size, in vCPUs, of auto jobs without their own.",
      { size: autoSize },
      object("The new size and the one it replaced.", {
        size: { type: "integer" },
        previous: { type: "integer" },
      }),
    ),
    "/workspaces/{workspaceId}/retry-settings": {
      ...read(
        "getRetrySettings",
        "Get automatic retries",
        "Whether jobs a runner failed are re-run, where, and how many times per run.",
        object("The retry settings.", {
          enabled: { type: "boolean" },
          runner: { type: "string" },
          max: { type: "integer" },
        }),
        [workspacePath],
      ),
      ...change(
        "setRetrySettings",
        "Set automatic retries",
        "Turns automatic retries on or off. A setting left out stays as it is.",
        {
          enabled: { type: "boolean" },
          runner: { type: "string", enum: RETRY_RUNNERS },
          max: { type: "integer", minimum: 1, maximum: 2 },
        },
        object("The new settings and the ones they replaced.", { previous: record }),
        { required: [] },
      ),
    },
    "/workspaces/{workspaceId}/ai": {
      ...read(
        "getAi",
        "Get AI",
        "When the workspace turned off AI features, or null while they're on.",
        object("Whether AI is off.", { offAt: { type: ["string", "null"] } }),
        [workspacePath],
      ),
      ...change(
        "setAi",
        "Turn AI on or off",
        "Turning AI off also deletes the AI answers saved so far.",
        { enabled: { type: "boolean" } },
        object("Whether AI is on now, and before.", {
          enabled: { type: "boolean" },
          previous: { type: "boolean" },
        }),
      ),
    },
    "/workspaces/{workspaceId}/router-setup": read(
      "listWorkflows",
      "List workflows",
      "Every workflow that ran in the workspace's repos in the last 14 days, with how many of its runs went through RelayRunner, unrouted first, plus the hosted provider labels jobs ran on.",
      object("Recent workflows and hosted labels.", {
        days: { type: "integer" },
        workflows: list,
        labels: list,
      }),
      [{ name: "workspaceId", in: "path", required: true, schema: { type: "string" } }],
    ),
    "/machines": read(
      "listRunners",
      "List runners",
      "Every runner: connected machines and self-hosted runners from GitHub.",
      object("The workspace's runners.", { machines: list }),
    ),
    "/machines/{machineId}/pause": change(
      "pauseRunner",
      "Pause a runner",
      "Stops routing jobs to a runner, in every workspace, until it's resumed. Only a connected machine's owner, or an owner or admin for a runner added from GitHub.",
      {},
      object("The runner.", { machine: record }),
      {
        method: "post",
        parameters: [{ name: "machineId", in: "path", required: true, schema: { type: "string" } }],
      },
    ),
    "/machines/{machineId}/resume": change(
      "resumeRunner",
      "Resume a runner",
      "Routes jobs to a paused runner again. Same rules as pausing.",
      {},
      object("The runner.", { machine: record }),
      {
        method: "post",
        parameters: [{ name: "machineId", in: "path", required: true, schema: { type: "string" } }],
      },
    ),
    "/runs": read(
      "listRuns",
      "List runs",
      "Workflow runs, newest first, at most 200.",
      object("Recent runs.", { runs: list, truncated: { type: "boolean" } }),
      [daysQuery(RAW_RETENTION_DAYS, 14), ...runFilterQueries],
    ),
    "/runs/{repositoryId}/{runId}/{runAttempt}/jobs": read(
      "getRunJobs",
      "List a run's jobs",
      "One run attempt's jobs and where each ran.",
      object("The run's jobs."),
      ["repositoryId", "runId", "runAttempt"].map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "integer", minimum: 1 },
      })),
    ),
    "/runs/{repositoryId}/{runId}/{runAttempt}/failures": read(
      "getRunFailures",
      "Explain a run's failures",
      "Why a run attempt's jobs failed: each failed job's first failed step, whether its runner failed it before any step ran, GitHub's annotations, and the end of its log up to the last error. Covers up to 5 failed jobs.",
      object("The run's failed jobs.", { jobs: list, more: { type: "integer" } }),
      ["repositoryId", "runId", "runAttempt"].map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "integer", minimum: 1 },
      })),
    ),
    "/activity": read(
      "listActivity",
      "List activity",
      "The activity log, newest first: where each job was routed and why.",
      object("One page of activity.", {
        items: list,
        nextBefore: { type: ["integer", "null"] },
      }),
      [
        {
          name: "before",
          in: "query",
          description: "The previous page's nextBefore.",
          schema: { type: "integer", minimum: 1 },
        },
        {
          name: "filter",
          in: "query",
          schema: { type: "string", enum: ACTIVITY_FILTERS },
        },
        {
          name: "since",
          in: "query",
          description: "Only events after this time, in milliseconds since the epoch.",
          schema: { type: "integer", minimum: 0 },
        },
        {
          name: "repository",
          in: "query",
          description: "Only this repository (owner/name).",
          schema: { type: "string" },
        },
        {
          name: "result",
          in: "query",
          schema: { type: "string", enum: ACTIVITY_RESULTS },
        },
        {
          name: "machine",
          in: "query",
          description: "Only this machine, by id.",
          schema: { type: "string" },
        },
      ],
    ),
    "/usage": read(
      "getUsage",
      "Get usage",
      "Jobs under a minute and what rounding up to whole minutes cost. The run filters count only the last 62 days.",
      object("The usage report."),
      [daysQuery(90, 30), ...runFilterQueries],
    ),
    "/usage/pull-requests": read(
      "getPullRequestMinutes",
      "Get minutes per pull request",
      "CI minutes per pull request, across its pushes and re-runs, with re-run minutes, estimated cost, commits and when each opened and merged. The summary covers every pull request in the range; pullRequests is one page of them.",
      object("Minutes per pull request.", {
        summary: record,
        pullRequests: list,
        outside: list,
        repositories: list,
      }),
      [
        daysQuery(RAW_RETENTION_DAYS, 30),
        stringQuery("repo", "Only this repo's pull requests, as owner/name."),
        stringQuery(
          "sort",
          "What the pull requests are ordered by, most first. Add -asc for least first. date is when it merged, or opened if it hasn't.",
          { enum: PULL_REQUEST_SORTS, default: "minutes" },
        ),
        {
          name: "offset",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 0, default: 0 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: {
            type: "integer",
            minimum: 1,
            maximum: PULL_REQUEST_MAX_PAGE,
            default: PULL_REQUEST_PAGE,
          },
        },
      ],
    ),
    "/usage/breakdown": read(
      "getBreakdown",
      "Get a breakdown",
      "The workspace's jobs added up one way: runs, jobs, minutes, billed minutes, estimated cost at GitHub's rates, failures and average wait per row, optionally per day.",
      object("The breakdown.", { by: { type: "string" }, total: record, rows: list }),
      [
        {
          name: "by",
          in: "query",
          required: true,
          schema: { type: "string", enum: BREAKDOWN_BY },
        },
        daysQuery(RAW_RETENTION_DAYS, 30),
        stringQuery("sort", "What the rows are ordered by.", {
          enum: BREAKDOWN_SORTS,
          default: "minutes",
        }),
        {
          name: "limit",
          in: "query",
          required: false,
          schema: {
            type: "integer",
            minimum: 1,
            maximum: BREAKDOWN_MAX_ROWS,
            default: BREAKDOWN_DEFAULT_ROWS,
          },
        },
        {
          name: "perDay",
          in: "query",
          required: false,
          description: "1 adds each row's numbers per day.",
          schema: { type: "integer", enum: [0, 1], default: 0 },
        },
        {
          name: "utcOffset",
          in: "query",
          required: false,
          description: "Minutes east of UTC, so days end at the reader's midnight.",
          schema: {
            type: "integer",
            minimum: -MAX_UTC_OFFSET_MINUTES,
            maximum: MAX_UTC_OFFSET_MINUTES,
            default: 0,
          },
        },
        ...runFilterQueries,
      ],
    ),
    "/usage/checks": read(
      "getCheckSavings",
      "Get check savings",
      "What optimized checks saved.",
      object("Optimized check savings."),
      [daysQuery(90, 30)],
    ),
    "/usage/actions": read(
      "getActionsMinutes",
      "Get Actions minutes",
      "Each connected GitHub account's Actions minutes this billing cycle.",
      object("Actions minutes by account."),
    ),
    "/job-times": read(
      "getJobTimes",
      "Get job times",
      "How long each job usually takes on each runner environment.",
      object("Job times by workflow, job and environment."),
      [daysQuery(30, 14), ...runFilterQueries],
    ),
    "/providers": read(
      "listProviders",
      "List providers",
      "Each provider jobs ran on: jobs, failures, billed minutes, estimated cost at list price, quick starts, runner failures and times, with billed minutes in the window before.",
      object("Providers.", { days: { type: "integer" }, providers: list }),
      [daysQuery(RAW_RETENTION_DAYS, 30)],
    ),
    "/providers/{provider}": read(
      "getProvider",
      "Get a provider",
      "One provider's runner types, with counts, price per minute and times, and the workflows that use it most.",
      object("The provider.", { provider: { type: "string" }, runners: list }),
      [providerPath, daysQuery(RAW_RETENTION_DAYS, 30)],
    ),
    "/providers/{provider}/trends": read(
      "getProviderTrends",
      "Get a provider's trends",
      "Queue wait and job time at p50 to p99, and runner failures, for the provider's busiest runner types, a day (or a week) at a time.",
      object("The provider's trends.", { bucketMs: { type: "integer" }, runners: list }),
      [providerPath, daysQuery(RAW_RETENTION_DAYS, 30)],
    ),
    "/workspaces/{workspaceId}/route-outcomes": read(
      "getRouteOutcomes",
      "Get routing outcomes",
      "How routed runs went: took their first step, moved further down the runner order (and why), waited for a busy machine, or found nothing that could take them.",
      object("Routing outcomes.", { runs: { type: "integer" }, reasons: list }),
      [workspacePath, daysQuery(RAW_RETENTION_DAYS, 7)],
    ),
    "/signals": read(
      "getSignals",
      "Get signals",
      "What's making CI slow, costly or busier than it needs to be: each signal's area, jobs, minutes, estimated cost and the repos and workflows it affects most, plus every job's minutes by person, repository, workflow, branch and trigger.",
      object("Signals and the breakdown.", {
        days: { type: "integer" },
        totals: record,
        signals: list,
      }),
      [
        daysQuery(90, 30),
        {
          name: "breakdown",
          in: "query",
          description: "0 leaves out the breakdown.",
          schema: { type: "integer", enum: [0, 1], default: 1 },
        },
      ],
    ),
    "/feedback": {
      post: {
        operationId: "sendFeedback",
        summary: "Send feedback",
        description: "Report a bug, a confusing result or a missing feature to the team.",
        parameters: [workspaceHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["category", "summary"],
                properties: {
                  category: { type: "string", enum: FEEDBACK_CATEGORIES },
                  summary: { type: "string", minLength: 1, maxLength: FEEDBACK_LIMITS.summary },
                  details: { type: "string", maxLength: FEEDBACK_LIMITS.details },
                  tool: { type: "string", maxLength: FEEDBACK_LIMITS.tool },
                },
              },
            },
          },
        },
        responses: {
          "201": object("Stored. The answer never repeats what was sent.", {
            id: { type: "string" },
            redacted: { type: "integer" },
          }),
          ...errors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      oauth: {
        type: "oauth2",
        description:
          "OAuth 2.1 with PKCE. Clients can register themselves (dynamic client registration). Discovery: https://app.relayrunner.dev/.well-known/oauth-authorization-server/api/auth",
        flows: {
          authorizationCode: {
            authorizationUrl: `${AUTH}/oauth2/authorize`,
            tokenUrl: `${AUTH}/oauth2/token`,
            refreshUrl: `${AUTH}/oauth2/token`,
            scopes: { "workspace:read": "Read the workspaces the person picks." },
          },
        },
      },
    },
    responses: {
      Error: {
        description:
          "The request failed. Branch on `error.code`; `error.message` is for people and can change. See https://relayrunner.dev/docs/reference/errors.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error"],
              properties: {
                error: {
                  type: "object",
                  required: ["code", "message"],
                  properties: {
                    code: {
                      type: "string",
                      description: "Stable. New codes can be added, so handle ones you don't know.",
                      enum: Object.keys(ERRORS),
                    },
                    message: { type: "string" },
                    details: { description: "More context, on some codes." },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
