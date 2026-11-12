---
title: Usage and savings
description: Minutes, cost estimates, and what optimized checks saved.
---

The **Usage** page covers every job in your connected repos, whichever runner took it.

## Actions minutes

For each connected GitHub account: minutes used this month against the plan's included minutes, and how fast they're going. It's the same number a [minutes limit](/docs/concepts/runner-order#the-minutes-limit) uses, and the page says when an account's minutes can't be read.

## Short jobs

GitHub bills each job by the minute, rounded up, so a job that finishes in 5 seconds pays for a whole minute. The page shows, per repo, how many jobs finished in under a minute and what that round-up cost. These are good candidates for optimized checks or a machine.

Estimates use GitHub's list prices for private repos. Standard runners in public repos and self-hosted runners are free.

## Saved by optimized checks

Each [optimized check](/docs/concepts/optimized-checks) counts as a job on `ubuntu-latest` that would have billed at least a minute.

## Providers

The **Providers** page shows how much of your CI ran on each provider, with cost estimates at list prices, and which providers you haven't used yet. See [Providers](/docs/runners/providers).
