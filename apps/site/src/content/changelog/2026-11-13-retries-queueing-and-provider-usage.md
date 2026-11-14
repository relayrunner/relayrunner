---
title: Retries, queueing and provider usage
date: 2026-11-13
description: The Router retries jobs whose runner failed them, waits for busy machines and skips stuck providers, and the dashboard syncs real usage from your providers.
---

- **Automatic retries.** The Router can re-run a job that failed because of its runner, not its own steps: the runner never started it, its machine went offline, or GitHub lost touch with it. The retry routes again, so it can land on a different runner. Turn it on with **Retry jobs when their runner fails** on the Router page, or per repo with [`retry`](/docs/reference/repo-config#retry). See [Automatic retries](/docs/concepts/routing#automatic-retries).
- **Jobs wait for a busy machine.** When every machine that fits a job is busy and nothing later in your runner order can take it, the job now waits for a free slot instead of failing. See [When every machine is busy](/docs/concepts/routing#when-every-machine-is-busy).
- **Skip providers that stop picking up jobs.** When a hosted provider leaves jobs waiting with no runner, the Router sends new jobs further down your runner order until it recovers. See [When a provider stops picking up jobs](/docs/concepts/routing#when-a-provider-stops-picking-up-jobs).
- **Real usage from your providers.** Connect Depot, Namespace or WarpBuild with a read-only token in **Settings → Providers**, and the dashboard pulls your real usage from them every hour.
