---
title: RelayRunner API
description: Read your workspace's runners, runs, routing and usage over HTTP, and change its routing.
---

The RelayRunner API is the HTTP API behind the [MCP server](/docs/reference/mcp). It reads a workspace's runners, runs, routing and usage, and changes its routing where you allow it.

:::tip[Connecting an AI agent?]
Use the [MCP server](/docs/reference/mcp) instead. Claude, Cursor, VS Code and other MCP clients sign in on their own and get these routes as tools. Call the API directly only if you're writing your own OAuth client.
:::

```text
https://api.relayrunner.dev/api
```

[API routes](/docs/reference/api/routes) lists every route with its parameters and responses, and you can try them there. The [OpenAPI spec](/openapi.json) has the same in JSON.

## Sign in

The API uses OAuth 2.1 with PKCE and the `workspace:read` scope. Clients can register themselves, and the authorization server publishes its endpoints at `https://app.relayrunner.dev/.well-known/oauth-authorization-server/api/auth`. While signing in, you pick which workspaces the token may read.

Send the access token as `Authorization: Bearer <token>`. Tokens last 15 minutes; use the refresh token for a new one. When a token covers more than one workspace, name the one you're asking about in the `x-relayrunner-workspace` header.

## Routes

| Route                                                    | What it returns                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /me`                                                | You and the workspaces the token may read                              |
| `GET /workspaces/current`                                | One workspace, your role and its GitHub accounts                       |
| `GET /workspaces/{id}/runner-order`                      | The providers jobs are tried on, in order                              |
| `GET /workspaces/{id}/router-setup`                      | Recent workflows and how many of their runs were routed                |
| `GET /machines`                                          | Runners, their status, labels, pause state and current job             |
| `GET /runs`                                              | Workflow runs from the last 14 days                                    |
| `GET /runs/{repositoryId}/{runId}/{runAttempt}/jobs`     | One run's jobs and where each ran                                      |
| `GET /runs/{repositoryId}/{runId}/{runAttempt}/failures` | Why a run's jobs failed, with the end of each log                      |
| `GET /activity`                                          | The activity log, including where each job was routed and why          |
| `GET /usage`, `/usage/checks`, `/usage/actions`          | Short jobs and round-up cost, optimized check savings, Actions minutes |
| `GET /job-times`                                         | Typical job durations per runner                                       |
| `GET /signals`                                           | What's making CI slow, costly or busier than it needs to be            |
| `GET /workspaces/{id}/auto-jobs`                         | Auto jobs' sizes and first providers, and the default size             |
| `GET /workspaces/{id}/retry-settings`, `/ai`             | Automatic retries, and whether AI is on                                |
| `POST /feedback`                                         | Reports a bug, confusing result or missing feature to the team         |

These change settings. They work only in workspaces where an owner or admin turned on **Allow changes** for the connection under **Settings → Agents**, and only for owners and admins (pausing follows the dashboard's rules). Elsewhere they answer `403` with `AGENT_CHANGES_OFF` or `FORBIDDEN`. Each change shows in the workspace's Activity, and each answer includes the value it replaced as `previous`.

| Route                                    | What it changes                                                       |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `PUT /workspaces/{id}/runner-order`      | The runner order. Pass `version` from the GET to refuse a stale write |
| `PUT /workspaces/{id}/auto-size`         | The default size for auto jobs                                        |
| `PUT /workspaces/{id}/auto-jobs/{jobId}` | One auto job's size and first provider                                |
| `PUT /workspaces/{id}/retry-settings`    | Automatic retries                                                     |
| `PUT /workspaces/{id}/ai`                | AI features, on or off                                                |
| `POST /machines/{id}/pause`, `/resume`   | Whether jobs route to a runner                                        |

A failed request answers with a code and a message, such as `{"error": {"code": "INVALID_REQUEST", "message": "The request isn't valid."}}`. [Errors](/docs/reference/errors) lists every code.

## Rate limit

Each person's connection can make 300 requests a minute, counting requests from the MCP server too. Past that, the API answers `429` with the `RATE_LIMITED` code and a `Retry-After` header.
