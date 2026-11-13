---
title: Activity and history
description: Where each job ran, why it ran there, and how long it waited.
---

Two dashboard pages show what happened in your CI: **Activity** and **History**. Both cover every repo the workspace's GitHub installation can see. For how long things usually take, see [Performance](/docs/dashboard/performance).

## Activity

**Activity** lists routed jobs, optimized checks, machine events and member changes, newest first. For each routed job it shows the runner it got, and **Show why** lists every step of the runner order that passed on it, with the reason, such as no free machine or a minutes limit reached.

A relay that failed shows the same message the job failed with on GitHub. Filter by time, repo, result or machine.

## History

**History** has two tabs:

- **Workflows** lists every workflow run, newest first. Routed runs are marked, and each run's time is compared with its workflow's usual time.
- **Jobs** lists every job a runner finished, newest first, with where it ran, how long it waited and ran, and how it ended. Search by job or workflow name.

Click a run to open it in a side panel: each job, where it ran, and how long it waited for a runner. Click a job to see its steps and how long each took, then step back up to its run. Each panel links to GitHub and to the job's usual times in Performance, and its address can be shared.

A chart above each list shows how long every run or job took over the chosen range, one dot each. Switch it to bars to see how many finished per hour (or per 6 or 12 hours on longer ranges), split by result. The chart follows the range and filters above it.

## From an agent

The same data is available to agents through the [MCP server](/docs/reference/mcp), such as "where did the last run of `test` go, and why?".
