---
title: Optimized checks
description: Simple checks that run with no runner and no billed minutes.
---

Simple checks like a PR title check, a PR description check or lint finish in seconds, but GitHub bills each job as a whole minute. An optimized check runs without a runner, so it uses no minutes.

## The checks

| Check          | What it does                                                                                                                            | Who can use it                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| PR title       | Fails unless the pull request title is a [Conventional Commit](https://www.conventionalcommits.org/), such as `feat(api): add a check`. | Every repo, public ones included  |
| PR description | Fails when the pull request has no description. A PR template left as is still fails.                                                   | Every repo, public ones included  |
| Lint           | Runs linters on the commit and reports each problem on its file and line.                                                               | Organizations in the lint preview |

PR title and PR description read only the pull request's title and description, so they need no sandbox and never read your code. Lint reads your code in a sandbox, so it's in preview while we turn it on for more organizations.

## Turn them on

Add `relayrunner.yml` to the repo's root or `.github/` folder, and the checks run on every pull request with no workflow:

```yaml
checks:
  pr-title: true
  pr-description: true
  lint: [oxlint, typos]
```

You change a repo's checks in this file, not in the dashboard. Checks read it from the default branch, so a pull request can't turn off its own checks. PR title and PR description need only the RelayRunner GitHub App. Lint needs the separate RelayRunner Checks GitHub App, which can read the repo's code. See [Repo config](/docs/reference/repo-config) for every setting.

## As a job

You can also run the PR title check or lint as a workflow job, for example to lint on demand. Put the check in its own job on `runs-on: relayrunner`:

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

### Check actions

| Check             | What it does                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks/pr-title` | The PR title check. `types` narrows the allowed types.                                                                                                                              |
| `checks/lint`     | Runs linters on the commit and reports each problem on its file and line. `tools` picks the [linters](/docs/reference/repo-config#checkslint) and `paths` limits which files count. |

:::note[Lint is in preview]
Lint runs in RelayRunner's own sandbox with no internet access. The job reads your code with its own `GITHUB_TOKEN`, which GitHub revokes when the job ends, so it needs no extra App. It's only on for organizations we've enabled so far. The job fails with the reason otherwise.
:::

## See what they saved

The Usage page counts each optimized check as a job that would have billed at least a minute on `ubuntu-latest`. See [Usage and savings](/docs/dashboard/usage).
