---
title: RelayRunner API
description: Read your workspace's runners, runs, routing and usage over HTTP.
---

The RelayRunner API is the read-only HTTP API behind the [MCP server](/docs/reference/mcp).

:::tip[Connecting an AI agent?]
Use the [MCP server](/docs/reference/mcp) instead. Claude, Cursor, VS Code and other MCP clients sign in on their own and get these routes as tools. Call the API directly only if you're writing your own OAuth client.
:::

```text
https://api.relayrunner.app/api
```

The [OpenAPI spec](/openapi.json) describes every route, its parameters and its errors.

## Sign in

The API uses OAuth 2.1 with PKCE and the `workspace:read` scope. Clients can register themselves, and the authorization server publishes its endpoints at `https://app.relayrunner.app/.well-known/oauth-authorization-server/api/auth`. While signing in, you pick which workspaces the token may read.

Send the access token as `Authorization: Bearer <token>`. Tokens last 15 minutes; use the refresh token for a new one. When a token covers more than one workspace, name the one you're asking about in the `x-relayrunner-workspace` header.

## Routes

| Route                                                | What it returns                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /me`                                            | You and the workspaces the token may read                              |
| `GET /workspaces/current`                            | One workspace, your role and its GitHub accounts                       |
| `GET /workspaces/{id}/runner-order`                  | The providers jobs are tried on, in order                              |
| `GET /machines`                                      | Runners, their status, labels, pause state and current job             |
| `GET /runs`                                          | Workflow runs from the last 14 days                                    |
| `GET /runs/{repositoryId}/{runId}/{runAttempt}/jobs` | One run's jobs and where each ran                                      |
| `GET /activity`                                      | The activity log, including where each job was routed and why          |
| `GET /usage`, `/usage/checks`, `/usage/actions`      | Short jobs and round-up cost, optimized check savings, Actions minutes |
| `GET /job-times`                                     | Typical job durations per runner                                       |
| `POST /feedback`                                     | Reports a bug, confusing result or missing feature to the team         |

Errors come back as JSON with a short code, such as `{"error": "invalid_query"}`.

## Rate limit

Each person's connection can make 300 requests a minute, counting requests from the MCP server too. Past that, the API answers `429` with `{"error": "rate_limited"}` and a `Retry-After` header.
