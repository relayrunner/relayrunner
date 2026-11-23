---
title: Route a repo from the dashboard
date: 2026-11-19
description: Step through your repos on the Router page, pick each repo's jobs and sizes, and hand the change to your coding agent.
---

- **Route a repo.** The Router page takes you through one repo at a time: pick the repo, pick its jobs from recent runs, then copy a prompt for your coding agent or the `init` command. The page then waits for the repo's first routed run and tells you when it's routed. See [Route repos from the dashboard](/docs/get-started/move-over#route-repos-from-the-dashboard).
- **Sizes before the first run.** Pick each job's size while you route it, and the first routed run uses it.
- **Runner group check.** Repos your org's Default runner group leaves out are marked, with a link to fix it, before you route them.
- **`relayrunner init --auto`.** Writes `auto` in place of a Linux x64 job's label, so you set its size on the Router page.
