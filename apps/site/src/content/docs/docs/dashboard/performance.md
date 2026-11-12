---
title: Performance
description: How long your workflows and jobs usually take, and which runner suits each job.
---

The **Performance** page, under Analytics, shows how long your workflows and jobs usually take over the last 7, 14 or 30 days. Times come from successful runs only, since a failed run stops early. The ⓘ beside each column explains how it's worked out.

## Workflows

For each workflow: its runs, the share that succeeded, and the median and p90 time from a run's start to its last job finishing. That time includes any wait for a runner, so it's what you actually wait for. **Waiting** is how much of that time no job was running, mostly jobs waiting for a runner.

**Trend** compares the newer half of the runs with the older half; red means the workflow got slower. **Slowest job** is the job that usually takes longest. Open it to compare its times on each runner.

## Jobs

How long each job usually takes on each runner it ran on, fastest first. Use it to see which runner suits which job: a test suite that takes 2 minutes on your Mac and 9 on `ubuntu-latest` is a good one to route. Open a job for a chart of every run.

## Runners

Each runner's job count, median wait and run time, and success rate. The comparison column lines up the jobs a runner shares with Linux 2-core (or your busiest runner), so a runner that only takes quick jobs doesn't look faster than it is.

## From an agent

Agents can read the same times through the [MCP server](/docs/reference/mcp), such as "which runner is fastest for `test`?".
