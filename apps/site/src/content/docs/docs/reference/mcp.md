---
title: MCP server
description: Let AI agents read your workspace's runners, runs and usage, and change its routing.
---

The MCP server lets your agent answer questions about your CI without you opening the dashboard. Where you allow it, the agent can also change your routing, such as the runner order or a job's size.

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

For better answers, install the `relayrunner-ci-insights` skill with `npx skills add relayrunner/relayrunner`. It tells your agent which tool answers which question. See [Set up with an agent](/docs/get-started/agents#install-the-skills).

## Allow changes

An agent can only read until you turn on **Allow changes** for it under **Settings → Agents**, in each workspace. Then it can change the runner order, job sizes, automatic retries and AI, and pause or resume runners. It still acts as you: it can't change what you can't change in the dashboard.

Every change shows in **Activity** with your name and the agent's, such as "Ada set the default size for auto jobs to 4 vCPU through Claude". Agents ask before they change something, and each change answers the previous value, so you can ask the agent to undo it. In clients that support it, RelayRunner also asks you directly before a new runner order, pausing a runner or turning AI off. Turning Allow changes off takes effect at once. Agents can't delete anything or touch members, installs or billing.

## Skills

The server also serves the RelayRunner skills, so agents that support skills over MCP can load them without installing anything. Each one is a resource at `skill://<name>/SKILL.md`:

| Skill                     | What it covers                                                        |
| ------------------------- | --------------------------------------------------------------------- |
| `relayrunner`             | Setting up machines with the CLI and running them day to day          |
| `relayrunner-route-jobs`  | Routing a repo's jobs, and why a job was skipped                      |
| `relayrunner-ci-insights` | Which tool answers which question, such as why a job ran where it did |

## Things to ask

- "Are my runners online, and what are they running right now?"
- "Why did my last push run on GitHub instead of my Mac?"
- "Which jobs cost the most this month?"
- "How long does the test job usually take on each runner?"
- "What's making our CI slow?"
- "How often does the deploy workflow run per day?"
- "How many CI minutes did Claude's branches use this month?"
- "Which workflows aren't routed yet?"
- "Run the e2e job on 8 vCPU." (needs Allow changes)
- "Pause my Mac until tomorrow's demo is over." (needs Allow changes)

## Tools

| Tool                  | What it reads                                                           |
| --------------------- | ----------------------------------------------------------------------- |
| `list_workspaces`     | The workspaces this connection can read                                 |
| `get_workspace`       | One workspace, your role and its GitHub installation                    |
| `list_runners`        | Runners, their status, labels, pause state and current job              |
| `get_runner_order`    | The providers jobs are tried on, in order                               |
| `list_workflows`      | Recent workflows and which ones are routed                              |
| `list_runs`           | Workflow runs, by repo, workflow, person, branch, trigger or agent      |
| `get_run_jobs`        | One run's jobs and where each ran                                       |
| `get_run_failures`    | Why a run's jobs failed, with the end of each log (read from GitHub)    |
| `list_activity`       | The activity log, including where each job was routed and why           |
| `get_usage`           | Short jobs, round-up cost, check savings, Actions minutes, PR minutes   |
| `get_job_times`       | Typical job durations per runner                                        |
| `get_signals`         | What's making CI slow, costly or busier than it needs to be             |
| `get_breakdown`       | Runs, minutes, cost and failures by workflow, person, agent and more    |
| `get_providers`       | How each provider performed, and where the Router sent jobs             |
| `get_router_settings` | Auto jobs' sizes, the default size, automatic retries and AI            |
| `send_feedback`       | Reports a bug, confusing result or missing tool to the RelayRunner team |

These change settings, with Allow changes on:

| Tool                            | What it changes                                     |
| ------------------------------- | --------------------------------------------------- |
| `set_runner_order`              | The providers jobs are tried on, and their limits   |
| `set_default_size`              | The size auto jobs get unless they have their own   |
| `set_job_size`                  | One auto job's size and the provider it tries first |
| `set_retries`                   | Automatic retries, on or off                        |
| `set_ai`                        | AI features, on or off                              |
| `pause_runner`, `resume_runner` | Whether jobs route to a runner                      |

Every tool takes an optional `workspace`, needed only when the agent can read more than one.
