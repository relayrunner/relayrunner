---
title: Activity and runs
description: Where each job ran, why it ran there, and how long it waited.
---

The dashboard has three views of your CI. All of them cover every repo in your connected GitHub accounts.

## Activity

**Activity** lists routed jobs, free checks, machine events and member changes, newest first. For each routed job it shows the runner it got, and **Show why** lists every step of the runner order that passed on it, with the reason, such as no free machine or a minutes limit reached.

A relay that failed shows the same message the job failed with on GitHub. Filter by time, repo, result or machine.

## Runs

**Runs** lists every workflow run, newest first. Open one to see each job, where it ran, and how long it waited for a runner. Routed jobs are marked, and a run's time is compared with its usual time.

## Job times

**Job times** shows how long each job usually takes on each runner, from its recent successful runs. Use it to see which runner suits which job: a test suite that takes 2 minutes on your Mac and 9 on `ubuntu-latest` is a good one to route. Wait is the time from queued until a runner picked the job up.

## From an agent

The same data is available to agents through the [MCP server](/docs/reference/mcp), such as "where did the last run of `test` go, and why?".
