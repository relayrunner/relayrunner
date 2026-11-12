---
title: Set up with an agent
description: Letting a coding agent set up RelayRunner and route your jobs for you.
---

A coding agent such as Claude Code, Codex or Cursor can do the whole setup: sign the machine in, pick which jobs to route, edit the workflows and show you the diff. Paste this into your agent, inside the repo's checkout:

```text
Set up relayrunner in this checkout using https://raw.githubusercontent.com/relayrunner/relayrunner/main/docs/agent-install.md
```

The [agent guide](https://github.com/relayrunner/relayrunner/blob/main/docs/agent-install.md) tells the agent to:

1. Check the machine is supported and install the CLI.
2. Sign the machine in with `relayrunner login`. You approve it in the browser.
3. Run `relayrunner init --plan --json` and go over which jobs can be routed, and why some are skipped.
4. Route the jobs you pick with `relayrunner init --apply`, then show you `git diff`. It doesn't commit or push unless you ask.
5. Put the machine online with `relayrunner connect`, ideally in your own terminal so it keeps running after the agent's session ends.

Every CLI command the agent uses has a `--json` flag, and every step is safe to retry.

## Let the agent see your CI

Agents can also read your workspace through the RelayRunner MCP server: runners, recent runs, where each job ran, and usage. It's read-only. See [MCP server](/docs/reference/mcp) to connect one.

## These docs, for agents

Every docs page is also available as Markdown. Add `.md` to a page's URL, or ask for it with `Accept: text/markdown`. [llms.txt](/llms.txt) lists every page, and [llms-full.txt](/llms-full.txt) has them all in one file.
