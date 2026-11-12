---
title: Runner order
description: The list a workspace tries runners in, and how to change it.
---

The runner order is your workspace's list of providers, top to bottom. Each job tries the steps in order and uses the first one its relay names that can take it now. Set it on the dashboard's **Router** page. Owners and admins can change it.

## Steps

| Step                  | Takes the job when                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-hosted**       | A connected machine or added runner is online, idle, has the relay's `machine` labels and is shared with whoever started the job. Never for public repos. |
| **GitHub-hosted**     | The relay names a `github` label. With a minutes limit, only while the account is under it.                                                               |
| **A hosted provider** | The relay names one of its labels, such as `depot-*` in the `depot` input. Always takes the job.                                                          |

A step that can't take the job is skipped with a reason, and the next one is tried.

## Common orders

**Machines first** (the default for a new workspace). Use your own hardware when it's free, and GitHub otherwise.

1. Self-hosted
2. GitHub-hosted

**Included minutes first.** Spend the minutes your plan includes, then move to your machines before overage, then fall back to GitHub anyway so nothing stalls. See [Spend controls](/docs/guides/spend-controls).

1. GitHub-hosted, while under 80%
2. Self-hosted
3. GitHub-hosted

**Machines, then a faster provider.** Burst to a [hosted provider](/docs/runners/hosted) such as Depot when your machines are busy, and keep GitHub as the last resort for jobs that don't name one.

1. Self-hosted
2. Depot
3. GitHub-hosted

GitHub can appear twice: once with a minutes limit and once without.

## The minutes limit

A GitHub-hosted step can have a limit, such as "while under 80%". It then takes a job only while the job's GitHub account has used less than that share of its plan's included minutes this month. Each account is checked on its own.

If GitHub won't share an account's minutes, the limit never blocks its jobs. The Router page shows when that's the case.

## Changes take effect at once

The order applies to the next relay. Nothing in your workflows changes.
