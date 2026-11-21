---
title: Spend controls
description: Use your included GitHub minutes first, then switch to your own machines before you pay overage.
---

A busy month, or a few agents pushing all day, can use up a plan's included minutes well before the month ends. After that, GitHub either bills overage or stops starting jobs. This guide keeps CI running without either.

## 1. Order the runners

On the **Router** page, set:

1. **GitHub-hosted**, capped at 80% of included minutes
2. **Self-hosted**
3. **GitHub-hosted**, no cap

Jobs use GitHub while the account is under 80% of its included minutes. Past that, they go to your machines. If no machine is free, the last step still sends them to GitHub, so nothing stalls.

Drop step 3 if you'd rather a job fail than ever bill overage. A job that finds no free machine then fails fast with the reason.

## 2. Pick the cap

Open the cap on the GitHub-hosted card and choose **Included minutes**. The cap is a share of the plan's included minutes for the month. 80% leaves room for jobs you haven't routed.

If you'd rather cap what GitHub bills you past the included minutes, choose **Monthly spend** instead. It reads what GitHub has billed the account for Actions this month.

Each GitHub account is checked on its own. One org going over its cap doesn't move another org's jobs.

## 3. Have somewhere to go

The cap only helps if there's a next step. Connect at least one machine, share it with the workspace if teammates push too, and route the jobs that use the most minutes. The **Usage** page shows which repos those are.

## Cap other providers too

Hosted provider steps, apart from Namespace and RunsOn, can have a monthly spend cap the same way, and a provider can come back later in the order with a higher cap. See [Spend limits](/docs/concepts/runner-order#spend-limits).

## Watch it

- **Router**: each step's minutes or spend this month, with a tick at its cap.
- **Activity**: jobs that passed GitHub by, marked with the account's usage at the time.
- **Usage**: minutes and cost per repo, and how much went on jobs that finished in seconds but billed a whole minute.

## Cut minutes you don't need

- **Short jobs** bill a whole minute each. An optimized check bills nothing. Move PR title checks and lint to [optimized checks](/docs/concepts/optimized-checks).
- **macOS minutes** cost about ten times Linux. Run macOS jobs on a Mac first. See [macOS and iOS builds on your Mac](/docs/guides/mac-builds).
