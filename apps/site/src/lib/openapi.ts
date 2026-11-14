/*
 * The OpenAPI description of the agent API, served at /openapi.json. These are the routes an
 * agent's OAuth token may call on https://api.relayrunner.app (AGENT_ROUTES in
 * apps/api/src/agent-auth.ts); the MCP server's tools call the same routes. A test in
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
import { MCP_URL } from "./mcp";

const AUTH = "https://app.relayrunner.app/api/auth";

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

export const openApi = {
  openapi: "3.1.0",
  info: {
    title: "RelayRunner API",
    version: "1.0.0",
    summary: "Read a workspace's runners, workflow runs, routing activity and CI usage.",
    description: `The read-only API behind the RelayRunner MCP server: a workspace's runners, runs, routing and usage. Sign in with OAuth (the \`workspace:read\` scope): the person picks which workspaces the token may read. To connect an AI agent, use the MCP server at ${MCP_URL} instead: MCP clients sign in on their own and get these routes as tools. Call this API directly only from your own OAuth client. Each connection can make 300 requests a minute; past that the API answers 429.`,
    contact: { url: "https://github.com/relayrunner/relayrunner/issues" },
    license: { name: "Apache-2.0", identifier: "Apache-2.0" },
  },
  externalDocs: { url: "https://relayrunner.app/docs/reference/api" },
  servers: [{ url: "https://api.relayrunner.app/api" }],
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
    "/workspaces/{workspaceId}/runner-order": read(
      "getRunnerOrder",
      "Get the runner order",
      "The providers jobs are tried on, top to bottom.",
      object("The runner order.", { order: list, isDefault: { type: "boolean" } }),
      [{ name: "workspaceId", in: "path", required: true, schema: { type: "string" } }],
    ),
    "/machines": read(
      "listRunners",
      "List runners",
      "Every runner: connected machines and self-hosted runners from GitHub.",
      object("The workspace's runners.", { machines: list }),
    ),
    "/runs": read(
      "listRuns",
      "List runs",
      "Workflow runs from the last 14 days, newest first.",
      object("Recent runs.", { runs: list, truncated: { type: "boolean" } }),
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
      "Jobs under a minute and what rounding up to whole minutes cost.",
      object("The usage report."),
      [daysQuery(90, 30)],
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
      [daysQuery(30, 14)],
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
          "OAuth 2.1 with PKCE. Clients can register themselves (dynamic client registration). Discovery: https://app.relayrunner.app/.well-known/oauth-authorization-server/api/auth",
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
        description: "The request failed. `error` is a short code, such as invalid_query.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error"],
              properties: { error: { type: "string" } },
            },
          },
        },
      },
    },
  },
};
