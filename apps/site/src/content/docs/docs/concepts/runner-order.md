---
title: Runner order
description: The list a workspace tries runners in, and how to change it.
---

The runner order is your workspace's list of providers, top to bottom. For each job, RelayRunner tries the steps in order and uses the first one the job's relay names that can take the job now. Set it on the dashboard's **Router** page. Owners and admins can change it.

## Steps

| Step              | Takes the job when                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-hosted**   | A connected machine or added runner is online, idle, has the relay's `machine` labels and is shared with whoever started the job. Never for public repos. |
| **GitHub-hosted** | The relay names a `github` label. With a minutes limit, only while the account is under it.                                                               |
| **Blacksmith**    | The relay names a `blacksmith-*` label. RelayRunner can't see Blacksmith's capacity, so this step always takes the job.                                   |

A step that can't take the job is skipped with a reason, and the next one is tried.

## Common orders

**Machines first** (the default for a new workspace). Use your own hardware when it's free, and GitHub otherwise.

1. Self-hosted
2. GitHub-hosted

**Included minutes first.** Spend the minutes your plan includes, then move to your machines before overage, then fall back to GitHub anyway so nothing stalls. See [Spend controls](/docs/guides/spend-controls/).

1. GitHub-hosted, while under 80%
2. Self-hosted
3. GitHub-hosted

**Machines, then a faster provider.** Burst to Blacksmith when your machines are busy, and keep GitHub as the last resort for jobs that don't name Blacksmith.

1. Self-hosted
2. Blacksmith
3. GitHub-hosted

GitHub can appear twice: once with a minutes limit and once without.

## The minutes limit

A GitHub-hosted step can have a limit, such as "while under 80%". It then takes a job only while the job's GitHub account has used less than that share of its plan's included minutes this month. Each account is judged on its own, never pooled across the workspace.

GitHub's billing data lags, so the step also stops a little early when an account is about to run out.

Some accounts' minutes can't be read: organizations inside a GitHub Enterprise, and personal accounts whose owner hasn't signed in to the workspace. The limit never blocks a job for those, and the Router page says which they are.

## Changes take effect at once

The order applies to the next relay. Nothing in your workflows changes.
