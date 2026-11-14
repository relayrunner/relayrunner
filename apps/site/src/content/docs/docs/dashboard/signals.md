---
title: Signals
description: What makes your CI slow, costly or busier than it needs to be, and which workflows it affects.
---

The **Signals** page, under Analytics, points out patterns in your CI that cost you time or money. Each signal has the same title every time, with the repos and workflows it affects listed underneath, most minutes first.

Signals are grouped by the question they answer:

- **Speed**: why is CI slow?
- **Cost**: why does CI cost this much?
- **Complexity**: is CI doing more than it needs to?

The page updates every hour. A signal shows up once it covers at least 30 minutes and 1% of all your job minutes in the range, so small one-offs stay off the page. Minutes and spend sit in separate columns. Spend uses the same list prices as the [Usage](/docs/dashboard/usage) page, so public repos and self-hosted runners count as free.

## Speed signals

Waiting for a runner and waiting on one job cost time rather than money, so those two signals leave the spend column empty.

### Waiting for a runner

These jobs waited more than a minute after GitHub queued them before a runner took them, grouped by their `runs-on` labels. Jobs wait when every runner with those labels is busy, or when the account reaches GitHub's limit on jobs running at once. Add a step to your [runner order](/docs/concepts/runner-order) so jobs go to the next runner that's free instead of waiting.

### One job sets the pace

This job ran alongside the others in its run and was still going after they all finished, so the run waited on it alone. The minutes are that wait. Jobs that wait for another job with `needs` aren't counted, since they start after it by design. Split the job, or compare its times on each runner on the [Performance](/docs/dashboard/performance) page.

### Flaky jobs

These jobs failed and then passed when the run was tried again, so the failure likely had nothing to do with the change. The minutes and spend are the failed attempts. Fixing the test or step that fails now and then saves the re-run and the wait for it.

## Cost signals

### No concurrency limit

These runs kept going after someone pushed again to the same branch. The minutes count from when the newer run started. Your default branch is left out, since most teams want every commit there to finish.

Add a concurrency group with `cancel-in-progress` to the workflow, and GitHub cancels the older run when a newer one starts:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

### Same commit runs twice

The workflow ran for the same commit from both `push` and `pull_request`. The push runs are the extra ones, so their minutes and spend are what the page shows. Limit `push` to your default branch and the pull request run still covers every change.

### Short jobs rounded up

GitHub bills each job by the whole minute. These jobs finished in under a minute on a billed runner, so part of every minute went unused. The page shows that unused part. Lint and other quick checks can run as [optimized checks](/docs/concepts/optimized-checks) instead.
