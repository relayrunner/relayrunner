---
title: Repo config
description: The relayrunner.yml file, which sets a repo's checks and retries.
---

`relayrunner.yml` turns on [optimized checks](/docs/concepts/optimized-checks) for every pull request in a repo, with no workflow. Put it at `.github/relayrunner.yml` or the repo root.

Checks read it from the default branch, so a pull request can't change the checks it gets.

```yaml
checks:
  pr-title: true
  lint: [oxlint, typos]
```

## `checks.pr-title`

`true` posts a **PR title** check on each pull request that passes when the title is a Conventional Commit. To narrow the allowed types:

```yaml
checks:
  pr-title:
    types: [feat, fix, docs, chore]
```

By default, all the usual Conventional Commit types are allowed.

## `checks.lint`

A list of linters to run on each pull request: any of `oxlint`, `oxfmt`, `ruff`, `actionlint`, `zizmor`, `shellcheck` and `typos`. To count only some files:

```yaml
checks:
  lint:
    tools: [oxlint]
    paths: ["apps/**"]
```

Each tool gets a `Lint / <tool>` check run. Lint needs the RelayRunner Checks GitHub App and is in preview.

## `retry`

Turns [automatic retries](/docs/concepts/routing#automatic-retries) on or off for the repo, whatever the workspace sets. `true` uses the workspace's choices, `false` turns retries off here, and you can set either choice:

```yaml
retry:
  runner: other # any, same or other
  max: 2 # retries per run, 1 or 2
```

## Mistakes

The file is checked strictly. An unknown key or a bad value fails the check with the reason, instead of being ignored.
