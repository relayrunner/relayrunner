---
title: Routing
description: How a job reaches RelayRunner and how it decides where the job runs.
---

A job opts in to routing with a relay job. The relay names the runners the job may use, and RelayRunner answers it with one of them.

## The relay job

```yaml
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1
    with:
      machine: macOS, ARM64
      github: macos-latest

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
    steps: ...
```

The relay takes one input per provider:

- **`machine`**: labels a self-hosted machine must have, all of them. `self-hosted` accepts any machine.
- **`github`**: a GitHub-hosted label, such as `ubuntu-latest`.
- **`blacksmith`**: a Blacksmith label, such as `blacksmith-4vcpu-ubuntu-2404`.

Leave out a provider and the job never runs there. See [relay.yml inputs](/docs/reference/relay-inputs/) for the details.

## What happens on a push

1. The relay job is queued on GitHub with `runs-on: relayrunner`.
2. GitHub tells RelayRunner, which answers the relay itself. It runs no steps and bills no minutes. This takes about a second.
3. RelayRunner walks your workspace's [runner order](/docs/concepts/runner-order/) from the top. It skips any provider the job didn't name, and picks the first one that can take the job now.
4. The relay finishes with a `runner` output: a one-time label for a machine, or the job's own label for a hosted provider.
5. Your job runs on that label. A machine gets a fresh one-job runner for it.

If nothing fits, the relay fails with the reason and the job doesn't start. See [When nothing fits](#when-nothing-fits).

## Which machine

When the self-hosted step is reached, RelayRunner looks for a machine that is online, idle, not paused, has every `machine` label, and is shared with whoever started the job. Your own machines come first for your jobs. A machine runs one job at a time.

## Rules that always apply

- **Public repos never run on machines.** The self-hosted step is skipped for them.
- **A provider missing from the runner order is never used**, even if the relay names it.
- **One relay routes one job.** If two jobs or a matrix share one relay's output, only the first runs. Give each job its own relay.

## When nothing fits

The relay fails straight away with one line that names why each provider couldn't take the job, such as:

> No runner available: no self-hosted machine is online and idle; `github` isn't set on this relay.

The job that needs the relay doesn't start. Re-run it once a machine is back, or add a fallback so it doesn't happen again: give the relay a `github` label and keep GitHub-hosted in the runner order.

## When a machine goes away mid-job

Routing happens before a job starts. If you stop `relayrunner connect` or the machine sleeps while a job is running, that job fails, the same as on any self-hosted runner. Re-run it and it routes again.

To take a machine out of rotation without cutting off a running job, [pause it](/docs/runners/self-hosted/#pause) first.

## When RelayRunner can't answer

If the GitHub App isn't installed on the repo's owner, or RelayRunner can't be reached, the relay job stays queued until GitHub gives up on it. It doesn't fall back on its own, because only RelayRunner can answer a relay. See [Troubleshooting](/docs/reference/troubleshooting/).

## See why a job ran where it did

The dashboard's **Activity** page shows each routed job, the runner it got, and every step that was skipped with the reason. See [Activity and runs](/docs/dashboard/activity/).
