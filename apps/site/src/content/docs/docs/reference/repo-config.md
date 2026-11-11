---
title: Repo config
description: The relayrunner.yml file, which turns on checks for a repo.
---

`relayrunner.yml` turns on [free checks](/docs/concepts/free-checks/) for every pull request in a repo, with no workflow. Put it at `.github/relayrunner.yml` or the repo root. If both exist, the one in `.github/` wins.

RelayRunner reads it from the default branch, so a pull request can't change the checks it gets. The GitHub App can read only these two files.

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

The default types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` and `revert`.

## `checks.lint`

A list of linters to run on each pull request: any of `oxlint`, `oxfmt`, `ruff`, `actionlint`, `zizmor`, `shellcheck` and `typos`. To count only some files:

```yaml
checks:
  lint:
    tools: [oxlint]
    paths: ["apps/**"]
```

Each tool gets a `Lint / <tool>` check run. Lint needs the RelayRunner Checks GitHub App and is in preview.

## Mistakes

The file is checked strictly. An unknown key or a bad value fails the check with the reason, instead of being ignored.
