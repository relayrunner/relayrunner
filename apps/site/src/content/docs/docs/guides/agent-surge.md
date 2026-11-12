---
title: Keep up with coding agents
description: When agents push all day, run CI on your own machines first and burst to hosted runners when they're full.
sidebar:
  label: Agent CI surges
---

Coding agents open pull requests around the clock, and each push runs CI. A month's included minutes can go in a few days, a single self-hosted machine turns into a queue, and paying for fast hosted runners for every push adds up quickly.

This guide uses every machine you have first, and sends only the overflow to a hosted provider.

## 1. Connect what you have

Run `relayrunner connect` on every spare computer: the Mac mini, the old laptop, the home server. Each one runs a job or two at once (more with `--concurrency`), so more machines means more jobs at once. Share them with **anyone** in the workspace so jobs from agents and teammates can use them:

```sh
relayrunner share anyone
```

Jobs started by a bot only run on machines shared with anyone.

## 2. Burst to hosted runners

Set the runner order so the overflow goes to a provider instead of waiting:

1. **Self-hosted**
2. **Blacksmith** (optional, if you want faster hosted runners)
3. **GitHub-hosted**

When every machine is busy, the next job goes to the next step straight away, instead of queueing behind the others.

## 3. Cap the hosted spend

Put a minutes limit on GitHub so overflow stops billing at a point you choose. See [Spend controls](/docs/guides/spend-controls). With no unlimited step after it, a job that finds every machine busy fails fast with the reason, and the agent can retry.

## 4. Take the cheap jobs off runners

PR title checks and lint don't need a machine at all. Make them [optimized checks](/docs/concepts/optimized-checks) so they never wait for a runner or bill a minute.

## Watch it

The **Performance** page shows how long each job takes on each runner and how long it waited for one. If waits grow, connect another machine or move a step up.
