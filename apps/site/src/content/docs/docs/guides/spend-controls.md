---
title: Spend controls
description: Use your included GitHub minutes first, then switch to your own machines before you pay overage.
---

A busy month, or a few agents pushing all day, can use up a plan's included minutes well before the month ends. After that, GitHub either bills overage or stops starting jobs. This guide keeps CI running without either.

## 1. Order the runners

On the **Router** page, set:

1. **GitHub-hosted, while under 80%**
2. **Self-hosted**
3. **GitHub-hosted**

Jobs use GitHub while the account is under 80% of its included minutes. Past that, they go to your machines. If no machine is free, the last step still sends them to GitHub, so nothing stalls.

Drop step 3 if you'd rather a job fail than ever bill overage. A job that finds no free machine then fails fast with the reason.

## 2. Pick the limit

The limit is a share of the plan's included minutes for the month. 80% leaves room for jobs you haven't routed.

Each GitHub account is checked on its own. One org going over its limit doesn't move another org's jobs.

## 3. Have somewhere to go

The limit only helps if there's a next step. Connect at least one machine, share it with the workspace if teammates push too, and route the jobs that use the most minutes. The **Usage** page shows which repos those are.

## Watch it

- **Router**: each account's minutes used this month, next to the limit.
- **Activity**: jobs that passed GitHub by, marked with the account's usage at the time.
- **Usage**: minutes and cost per repo, and how much went on jobs that finished in seconds but billed a whole minute.

## Cut minutes you don't need

- **Short jobs** bill a whole minute each. An optimized check bills nothing. Move PR title checks and lint to [optimized checks](/docs/concepts/optimized-checks).
- **macOS minutes** cost about ten times Linux. Run macOS jobs on a Mac first. See [macOS and iOS builds on your Mac](/docs/guides/mac-builds).
