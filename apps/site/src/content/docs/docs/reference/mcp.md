---
title: MCP server
description: Let AI agents read your workspace's runners, runs and usage.
---

The MCP server lets your agent answer questions about your CI without you opening the dashboard. It's read-only, apart from sending feedback.

```text
https://agents.relayrunner.app/mcp
```

## Connect an agent

### Claude Code

Add the server, then run `/mcp` in Claude Code to sign in.

```sh
claude mcp add --transport http relayrunner https://agents.relayrunner.app/mcp
```

### Claude

In Claude, open **Settings → Connectors** and choose **Add custom connector**. Name it RelayRunner, paste the URL above, then choose **Connect**.

### Cursor

Add this to `~/.cursor/mcp.json`, then choose **Connect** next to RelayRunner in Cursor's MCP settings.

```json
{ "mcpServers": { "relayrunner": { "url": "https://agents.relayrunner.app/mcp" } } }
```

### VS Code

Add the server, then start it from the **MCP Servers** list to sign in.

```sh
code --add-mcp '{"name":"relayrunner","type":"http","url":"https://agents.relayrunner.app/mcp"}'
```

### Other agents

Add the URL as a remote MCP server (streamable HTTP). The agent signs in with OAuth, so there's no key to paste.

### Signing in

The first time the agent uses it, your browser opens. Sign in with GitHub, pick which workspaces the agent may read, and approve it. The same steps are in the dashboard under **Settings → Agents**, where you can also see and disconnect agents. Disconnecting, or leaving a workspace, cuts the agent off at once.

## Things to ask

- "Are my runners online, and what are they running right now?"
- "Why did my last push run on GitHub instead of my Mac?"
- "Which jobs cost the most this month?"
- "How long does the test job usually take on each runner?"

## Tools

| Tool               | What it reads                                                           |
| ------------------ | ----------------------------------------------------------------------- |
| `list_workspaces`  | The workspaces this connection can read                                 |
| `get_workspace`    | One workspace, your role and its GitHub installation                    |
| `list_runners`     | Runners, their status, labels, pause state and current job              |
| `get_runner_order` | The providers jobs are tried on, in order                               |
| `list_runs`        | Recent workflow runs, by repo, status or result                         |
| `get_run_jobs`     | One run's jobs and where each ran                                       |
| `list_activity`    | The activity log, including where each job was routed and why           |
| `get_usage`        | Short jobs and round-up cost, optimized check savings, Actions minutes  |
| `get_job_times`    | Typical job durations per runner                                        |
| `send_feedback`    | Reports a bug, confusing result or missing tool to the RelayRunner team |

Every tool takes an optional `workspace`, needed only when the agent can read more than one.
