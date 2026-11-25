# RelayRunner agents

The MCP server at `https://agents.relayrunner.app/mcp`. An AI agent connects to it to ask about a workspace's runners, runs and usage, and, where the person allows it, to change the workspace's routing settings. `send_feedback` lets an agent report a problem to the RelayRunner team.

```
agent ──▶ relayrunner-agents ──▶ relayrunner-api (service binding)
          MCP, stateless          checks the token, reads D1
   │
   └─ OAuth sign-in ──▶ app.relayrunner.dev (Better Auth in relayrunner-api)
```

## Signing in

The server speaks MCP's OAuth flow, so clients sign in on their own when you add the URL:

1. The first request gets a `401` pointing at `/.well-known/oauth-protected-resource/mcp`, which names the dashboard's auth server (`https://app.relayrunner.dev/api/auth`).
2. The client registers itself (dynamic client registration) and opens the dashboard. The person signs in with GitHub if needed, picks the workspaces it may read (`/agents/workspace`, all of them checked to start) and approves the client (`/agents/consent`).
3. The client gets a 15-minute access token for this server's URL, naming that grant of workspaces, with the `workspace:read` scope, plus a refresh token.

Each tool call forwards that token to the API, with the workspace it's about in `x-relayrunner-workspace`. The API verifies the token and only lets it read that one workspace, if the grant covers it, through a fixed list of routes (`apps/api/src/auth/agent-auth.ts`). Every tool takes an optional `workspace` (an id or name from `list_workspaces`), needed only when the connection reads more than one; no answer mixes workspaces. The grant and membership are checked on every call and every refresh, so removing someone from a workspace, or disconnecting the agent from it under Settings → Agents, cuts it off from that workspace at once. Workspaces joined later need a new connection.

Clients that look before they connect can read the server's [MCP Server Card](https://modelcontextprotocol.io/seps/2127-mcp-server-cards) at `/mcp/server-card` (`src/server-card.ts`), with no sign-in. https://relayrunner.dev/.well-known/ai-catalog.json points there.

This Worker holds no secrets and no state. It doesn't call GitHub or the Router: runners added from GitHub show `github.unreachable` instead of a live status. Each connection gets 120 requests a minute here, and the API caps agent tokens at 300 calls a minute (`AGENT_LIMITER`), which also covers clients that call it directly.

## Tools

| Tool                  | What it reads                                                              |
| --------------------- | -------------------------------------------------------------------------- |
| `list_workspaces`     | The workspaces this connection reads, by id and name                       |
| `get_workspace`       | One workspace, your role and its connected GitHub accounts                 |
| `list_runners`        | Runners, their status, labels, pause state and current job                 |
| `get_runner_order`    | The providers jobs are tried on, in order (a repo's own with `repository`) |
| `list_runs`           | Recent workflow runs, filterable by repository, status, conclusion         |
| `list_workflows`      | Recent workflows and which ones are routed                                 |
| `get_run_jobs`        | One run's jobs and where each ran                                          |
| `get_run_failures`    | Why a run's jobs failed, with the end of each log (read from GitHub)       |
| `list_activity`       | The activity log, including where each job was routed and why              |
| `get_usage`           | Short jobs and round-up cost, optimized check savings, Actions minutes     |
| `get_job_times`       | Typical job durations per runner environment                               |
| `get_signals`         | What's making CI slow, costly or busier than it needs to be                |
| `get_router_settings` | Auto jobs' sizes, the default size, automatic retries and AI               |
| `send_feedback`       | Writes: reports a bug, confusing result or missing tool to the team        |

## Changing settings

These tools (`src/write-tools.ts`) change a workspace's routing, each through the dashboard's own route:

| Tool                            | Route                                           |
| ------------------------------- | ----------------------------------------------- |
| `set_runner_order`              | `PUT /api/workspaces/:id/runner-order`          |
| `use_workspace_order`           | `DELETE /api/workspaces/:id/runner-order?repo=` |
| `set_default_size`              | `PUT /api/workspaces/:id/auto-size`             |
| `set_job_size`                  | `PUT /api/workspaces/:id/auto-jobs/:jobId`      |
| `set_retries`                   | `PUT /api/workspaces/:id/retry-settings`        |
| `set_ai`                        | `PUT /api/workspaces/:id/ai`                    |
| `pause_runner`, `resume_runner` | `POST /api/machines/:id/pause` and `resume`     |

They're off for every connection until the person who connected it turns on **Allow changes** for it in Settings → Agents, per workspace (`agent_grant_workspace.can_write`). The API reads that on every request, so turning it off takes effect at once, and answers `AGENT_CHANGES_OFF` where it's off. The routes still check the person's access as they do for the dashboard: workspace-wide settings need an owner or admin, and an auto job's size or a repo's own runner order also works for anyone who can push to that repo on GitHub. So an agent can't change what its person can't. There's no separate OAuth scope: clients rarely ask for one, and this way the switch is per workspace and needs no new sign-in.

Every change is logged in the workspace's Activity (`settings.*` events, and `machine.paused`/`resumed`) with the person and `via: "agent"` plus the agent's registered name; dashboard changes are logged the same way with `via: "dashboard"`. Each tool is marked destructive so clients ask before running it, and answers the previous value so the agent can undo it. Changes that stop or drop something (`set_runner_order`, `use_workspace_order`, `pause_runner`, `set_ai` turning AI off) also ask the person themselves, with an MCP elicitation, where the client declares it on the 2026-07-28 revision: the call answers `input_required` with a confirm form, and the client calls again with the reply. A "no" changes nothing. The 2025 path answers plain JSON and can't ask mid-call, so there it's up to the client. `set_runner_order` needs the `version` from `get_runner_order` and fails with `RUNNER_ORDER_CHANGED` if someone changed the order since. Agents can't delete data or touch members, installs or billing; `use_workspace_order` only removes a repo's own order.

## Feedback

`send_feedback` takes a category (`bug`, `confusing`, `feature_request`, `other`), a one-line summary (200 characters), optional details (4,000) and the tool it's about. It POSTs to `/api/feedback` (`apps/api/src/routes/feedback.ts`). The API strips control, zero-width and bidi characters, trims to those limits, redacts anything that looks like a credential (GitHub, RelayRunner machine and cloud tokens, JWTs, private keys, `key=value` secrets, passwords in URLs), stores it in the `feedback` table (with the dashboard's feedback) and emails it to `FEEDBACK_EMAIL` (feedback@relayrunner.app), with the person's address as Reply-To. Each person can send 10 an hour and 30 a day across all their agents. The answer is only an id and how many values were redacted; it never repeats the text.

## Run it locally

Start the API (`pnpm --filter @relayrunner/api dev`), then `pnpm --filter @relayrunner/agents dev`. Wrangler connects the `API` binding to the local API. Tokens are only issued for the production URL, so local sign-in needs `AGENTS_MCP_URL` (API) and `MCP_URL` (here) pointed at the local server.

## Deploy

`pnpm deploy:agents`. The first deploy creates the `agents.relayrunner.app` custom domain.
