# RelayRunner agents

The MCP server at `https://agents.relayrunner.app/mcp`. An AI agent connects to it to ask about a workspace's runners, runs and usage. It's read-only, apart from `send_feedback`, which lets an agent report a problem to the RelayRunner team.

```
agent ──▶ relayrunner-agents ──▶ relayrunner-api (service binding)
          MCP, stateless          checks the token, reads D1
   │
   └─ OAuth sign-in ──▶ app.relayrunner.app (Better Auth in relayrunner-api)
```

## Signing in

The server speaks MCP's OAuth flow, so clients sign in on their own when you add the URL:

1. The first request gets a `401` pointing at `/.well-known/oauth-protected-resource/mcp`, which names the dashboard's auth server (`https://app.relayrunner.app/api/auth`).
2. The client registers itself (dynamic client registration) and opens the dashboard. The person signs in with GitHub if needed, picks the workspaces it may read (`/agents/workspace`, all of them checked to start) and approves the client (`/agents/consent`).
3. The client gets a 15-minute access token for this server's URL, naming that grant of workspaces, with the `workspace:read` scope, plus a refresh token.

Each tool call forwards that token to the API, with the workspace it's about in `x-relayrunner-workspace`. The API verifies the token and only lets it read that one workspace, if the grant covers it, through a fixed list of GET routes (`apps/api/src/agent-auth.ts`). Every tool takes an optional `workspace` (an id or name from `list_workspaces`), needed only when the connection reads more than one; no answer mixes workspaces. The grant and membership are checked on every call and every refresh, so removing someone from a workspace, or disconnecting the agent from it under Settings → Agents, cuts it off from that workspace at once. Workspaces joined later need a new connection.

This Worker holds no secrets and no state. It doesn't call GitHub or the Router: runners added from GitHub show `github.unreachable` instead of a live status. Each connection gets 120 requests a minute.

## Tools

| Tool               | What it reads                                                          |
| ------------------ | ---------------------------------------------------------------------- |
| `list_workspaces`  | The workspaces this connection reads, by id and name                   |
| `get_workspace`    | One workspace, your role and its connected GitHub accounts             |
| `list_runners`     | Runners, their status, labels, pause state and current job             |
| `get_runner_order` | The providers jobs are tried on, in order                              |
| `list_runs`        | Recent workflow runs, filterable by repository, status, conclusion     |
| `get_run_jobs`     | One run's jobs and where each ran                                      |
| `list_activity`    | The activity log, including where each job was routed and why          |
| `get_usage`        | Short jobs and round-up cost, optimized check savings, Actions minutes |
| `get_job_times`    | Typical job durations per runner environment                           |
| `send_feedback`    | Writes: reports a bug, confusing result or missing tool to the team    |

## Feedback

`send_feedback` takes a category (`bug`, `confusing`, `feature_request`, `other`), a one-line summary (200 characters), optional details (4,000) and the tool it's about. It POSTs to `/api/feedback`, the only write an agent token may make (`apps/api/src/routes/feedback.ts`). The API strips control, zero-width and bidi characters, trims to those limits, redacts anything that looks like a credential (GitHub, RelayRunner machine and cloud tokens, JWTs, private keys, `key=value` secrets, passwords in URLs), stores it in the `agent_feedback` table and emails it to `FEEDBACK_EMAIL` (feedback@relayrunner.app), with the person's address as Reply-To. Each person can send 10 an hour and 30 a day across all their agents. The answer is only an id and how many values were redacted; it never repeats the text.

## Run it locally

Start the API (`pnpm --filter @relayrunner/api dev`), then `pnpm --filter @relayrunner/agents dev`. Wrangler connects the `API` binding to the local API. Tokens are only issued for the production URL, so local sign-in needs `AGENTS_MCP_URL` (API) and `MCP_URL` (here) pointed at the local server.

## Deploy

`pnpm deploy:agents`. The first deploy creates the `agents.relayrunner.app` custom domain.
