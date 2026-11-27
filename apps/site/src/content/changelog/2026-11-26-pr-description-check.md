---
title: PR description check
date: 2026-11-26
type: Feature
description: A new optimized check fails pull requests with no description, and the PR title and description checks are open to every repo.
---

- **PR description check.** Add `pr-description: true` under `checks` in `relayrunner.yml` and every pull request gets a **PR description** check that fails when the description is empty. HTML comments don't count, so a PR template left as is still fails. Set `min-length` to ask for more than a line. See [Repo config](/docs/reference/repo-config#checkspr-description).
- **Open to every repo.** The PR title and description checks run from the pull request alone, with no runner and no access to your code, so any repo with the RelayRunner GitHub App can turn them on, public ones included. Lint is still in limited preview.
- **Edits rerun only what changed.** Editing a pull request's description reruns its description check, and editing the title reruns the title check.
