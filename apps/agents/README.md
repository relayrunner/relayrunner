# RelayRunner agents

The MCP server at `https://agents.relayrunner.app/mcp`. An AI agent connects to it to ask about a workspace's runners, runs and usage. It's read-only for now: no tool changes anything.

```
agent ──▶ relayrunner-agents ──▶ relayrunner-api (service binding)
          MCP, stateless          checks the token, reads D1
   │
   └─ OAuth sign-in ──▶ app.relayrunner.app (Better Auth in relayrunner-api)
```

## Signing in

The server speaks MCP's OAuth flow, so clients sign in on their own when you add the URL:

1. The first request gets a `401` pointing at `/.well-known/oauth-protected-resource/mcp`, which names the dashboard's auth server (`https://app.relayrunner.app/api/auth`).
2. The client registers itself (dynamic client registration) and opens the dashboard. The person signs in with GitHub if needed, picks one workspace (`/agents/workspace`) and approves the client (`/agents/consent`).
3. The client gets a 15-minute access token for this server's URL, naming that workspace, with the `workspace:read` scope, plus a refresh token.

Each tool call forwards that token to the API, which verifies it and only lets it read the workspace it names, through a fixed list of GET routes (`apps/api/src/agent-auth.ts`). Membership is checked on every call and every refresh, so removing someone from the workspace cuts their agents off. People see and disconnect their agents under Settings → Agents.

This Worker holds no secrets and no state. It doesn't call GitHub or the Router: runners added from GitHub show `github.unreachable` instead of a live status. Each user and workspace gets 120 requests a minute.

## Tools

| Tool               | What it reads                                                      |
| ------------------ | ------------------------------------------------------------------ |
| `get_workspace`    | The workspace, your role and its connected GitHub accounts         |
| `list_runners`     | Runners, their status, labels, pause state and current job         |
| `get_runner_order` | The providers jobs are tried on, in order                          |
| `list_runs`        | Recent workflow runs, filterable by repository, status, conclusion |
| `get_run_jobs`     | One run's jobs and where each ran                                  |
| `list_activity`    | The activity log, including where each job was routed and why      |
| `get_usage`        | Short jobs and round-up cost, free check savings, Actions minutes  |
| `get_job_times`    | Typical job durations per runner environment                       |

## Run it locally

Start the API (`pnpm --filter @relayrunner/api dev`), then `pnpm --filter @relayrunner/agents dev`. Wrangler connects the `API` binding to the local API. Tokens are only issued for the production URL, so local sign-in needs `AGENTS_MCP_URL` (API) and `MCP_URL` (here) pointed at the local server.

## Deploy

`pnpm deploy:agents`. The first deploy creates the `agents.relayrunner.app` custom domain.
