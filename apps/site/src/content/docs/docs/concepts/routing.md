---
title: Routing
description: How a job opts in to routing, and how the relay picks its runner.
---

A job opts in to routing with a relay job. The relay names the runners the job may use, and gets one of them back.

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
- **A hosted provider's input**, such as `depot` or `blacksmith`: one of that provider's labels, such as `depot-ubuntu-24.04`. See [Hosted providers](/docs/runners/hosted).

Leave out a provider and the job never runs there. See [relay.yml inputs](/docs/reference/relay-inputs) for the details.

## What happens on a push

1. The relay job is queued on GitHub with `runs-on: relayrunner`.
2. GitHub tells RelayRunner, which answers the relay itself. It runs no steps and bills no minutes. This takes about a second.
3. The relay goes down your workspace's [runner order](/docs/concepts/runner-order) from the top. It skips any provider the job didn't name, and picks the first one that can take the job now.
4. The relay finishes with a `runner` output: a one-time label for a machine, or the job's own label for a hosted provider.
5. Your job runs on that label. A machine gets a fresh one-job runner for it.

If your machines are busy and nothing else fits, the job waits for one. See [When every machine is busy](#when-every-machine-is-busy). If nothing fits at all, the relay fails with the reason and the job doesn't start. See [When nothing fits](#when-nothing-fits).

## Which machine

The self-hosted step takes a machine that is online, idle, not paused, has every `machine` label, and is shared with whoever started the job. Your own machines come first for your jobs. A machine takes jobs while it has a free slot (see [Jobs at once](/docs/runners/self-hosted#jobs-at-once)).

## Rules that always apply

- **Public repos never run on machines.** The self-hosted step is skipped for them.
- **A provider missing from the runner order is never used**, even if the relay names it.
- **One relay routes one job.** If two jobs or a matrix share one relay's output, only the first runs. Give each job its own relay.

## When a provider stops picking up jobs

If a hosted provider's runner type leaves 3 jobs in a row waiting 10 minutes with no runner, the Router skips it and sends jobs to the next step instead. This covers outages, network trouble, and an account that hit its spend cap. A job that runs and fails doesn't count.

After 10 minutes, the Router sends one job back to try it. If a runner picks it up, the runner type is back in use. If not, the Router waits twice as long before the next try, up to an hour.

The Router page shows each runner type it's skipping, with a **Try again now** button for owners and admins. When no other step can take a job, the Router still sends it to the skipped runner type rather than failing the relay.

This is on by default. To keep sending jobs to a provider however long they wait, turn off **Skip runners that stop picking up jobs** at the bottom of the Router page.

## When every machine is busy

If every machine that fits is busy and no later step in your runner order can take the job, the job waits for a free slot instead of failing. The relay passes, and the job shows as queued on GitHub until a machine has room. Jobs get free slots in the order they started waiting.

A waiting job runs as soon as a slot frees, on whichever fitting machine frees first. Cancelling the run takes it out of line, and GitHub cancels a job that waits more than 24 hours.

To send jobs elsewhere instead of waiting, add a step after your machines, such as `github` or a hosted provider.

## When nothing fits

The relay fails straight away with one line that names why each provider couldn't take the job, such as:

> No runner available: no self-hosted machine is online and idle; `github` isn't set on this relay.

The job that needs the relay doesn't start. Re-run it once a machine is back, or add a fallback so it doesn't happen again: give the relay a `github` label and keep GitHub-hosted in the runner order.

## When a machine goes away mid-job

Routing happens before a job starts. If you stop `relayrunner connect` or the machine sleeps while a job is running, that job fails, the same as on any self-hosted runner. Turn on [automatic retries](#automatic-retries) to have the Router re-run it, or see [Re-running a job](#re-running-a-job).

To take a machine out of rotation without cutting off a running job, [pause it](/docs/runners/self-hosted#pause) first.

## Re-running a job

**Re-run all jobs** runs the relay again, so the job routes from the top of your runner order.

**Re-run failed jobs** keeps the relay's earlier answer, so where the job goes depends on the runner it had:

| The job ran on             | A re-run goes to                                                      |
| -------------------------- | --------------------------------------------------------------------- |
| A connected machine        | The same machine if it's free, else another machine that fits the job |
| A runner added from GitHub | The same runner                                                       |
| GitHub-hosted              | GitHub-hosted, with the same label                                    |
| A hosted provider          | The same provider, with the same label                                |

To move a failed job to a different provider, use **Re-run all jobs**.

## Automatic retries

The Router can re-run a job that failed because of its runner rather than its own steps. A job counts when:

- Its runner never started its steps.
- The connected machine running it went offline.
- GitHub lost touch with its runner.

A job whose own steps failed is never retried. GitHub only re-runs jobs once the whole run has finished, so the retry starts then. The Router re-runs the relay with it, so the retry routes again.

Turn this on with **Retry jobs when their runner fails** on the Router page. Owners and admins can choose:

- **Send the retry to**: any runner, the same runner first, or a different runner first. When nothing else can take a retry meant for a different runner, it goes back to the one it failed on.
- **Retries per run**: 1 or 2.

A repo can turn retries on or off for itself with [`retry`](/docs/reference/repo-config#retry) in its `relayrunner.yml`. Each retry shows on the Activity page with the reason. Runs with more than one relay aren't retried yet.

## When RelayRunner can't answer

If the GitHub App isn't installed on the repo's owner, or RelayRunner can't be reached, the relay job stays queued until GitHub gives up on it. It doesn't fall back on its own, because only RelayRunner can answer a relay. See [Troubleshooting](/docs/reference/troubleshooting).

## See why a job ran where it did

The dashboard's **Activity** page shows each routed job, the runner it got, and every step that was skipped with the reason. See [Activity and history](/docs/dashboard/activity).
