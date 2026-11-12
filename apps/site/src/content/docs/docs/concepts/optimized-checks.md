---
title: Optimized checks
description: Simple checks that run with no runner and no billed minutes.
---

Simple checks like a PR title check or lint finish in seconds, but GitHub bills each job as a whole minute. An optimized check runs without a runner, so it uses no minutes.

## As a job

Put the check in its own job on `runs-on: relayrunner`:

```yaml
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

jobs:
  pr-title:
    runs-on: relayrunner
    steps:
      - uses: relayrunner/actions/checks/pr-title@v1
```

Keep optimized checks in a job of their own. A job that mixes in other steps fails with the reason.

Each check is also an ordinary action, so the same job works on `ubuntu-latest` or your own runner if you point it there.

## The checks

| Check             | What it does                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks/pr-title` | Fails unless the pull request title is a [Conventional Commit](https://www.conventionalcommits.org/), such as `feat(api): add a check`. `types` narrows the allowed types.          |
| `checks/lint`     | Runs linters on the commit and reports each problem on its file and line. `tools` picks the [linters](/docs/reference/repo-config#checkslint) and `paths` limits which files count. |

:::note[Lint is in preview]
Lint runs in RelayRunner's own sandbox with no internet access. The job reads your code with its own `GITHUB_TOKEN`, which GitHub revokes when the job ends, so it needs no extra App. It's only on for organizations we've enabled so far. The job fails with the reason otherwise.
:::

## From repo config

The PR title check and lint can also run on every pull request with no workflow at all. Lint from repo config needs the separate RelayRunner Checks GitHub App, which can read the repo's code. Add `relayrunner.yml` to the repo's root or `.github/` folder:

```yaml
checks:
  pr-title: true
  lint: [oxlint, typos]
```

This works for public repos too. See [Repo config](/docs/reference/repo-config).

## See what they saved

The Usage page counts each optimized check as a job that would have billed at least a minute on `ubuntu-latest`. See [Usage and savings](/docs/dashboard/usage).
