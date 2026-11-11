---
title: MCP server
description: Let AI agents read your workspace's runners, runs and usage.
---

RelayRunner has an MCP server, so an agent can answer questions like "why did my last push run on GitHub?" or "which jobs cost the most this month?" without you opening the dashboard. It's read-only, apart from sending feedback.

```text
https://agents.relayrunner.app/mcp
```

## Connect an agent

Add the URL as a remote MCP server in your client. For Claude Code:

```sh
claude mcp add --transport http relayrunner https://agents.relayrunner.app/mcp
```

In Cursor, add it under **Settings → MCP**. Other clients that support remote MCP servers with OAuth work the same way.

The first time the agent uses it, your browser opens. Sign in with GitHub, pick which workspaces the agent may read, and approve it. See and disconnect agents under **Settings → Agents** in the dashboard. Disconnecting, or leaving a workspace, cuts the agent off at once.

## Tools

| Tool               | What it reads                                                           |
| ------------------ | ----------------------------------------------------------------------- |
| `list_workspaces`  | The workspaces this connection can read                                 |
| `get_workspace`    | One workspace, your role and its GitHub accounts                        |
| `list_runners`     | Runners, their status, labels, pause state and current job              |
| `get_runner_order` | The providers jobs are tried on, in order                               |
| `list_runs`        | Recent workflow runs, by repo, status or result                         |
| `get_run_jobs`     | One run's jobs and where each ran                                       |
| `list_activity`    | The activity log, including where each job was routed and why           |
| `get_usage`        | Short jobs and round-up cost, free check savings, Actions minutes       |
| `get_job_times`    | Typical job durations per runner                                        |
| `send_feedback`    | Reports a bug, confusing result or missing tool to the RelayRunner team |

Every tool takes an optional `workspace`, needed only when the agent can read more than one.
