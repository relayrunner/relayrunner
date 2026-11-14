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
