---
title: How it works with GitHub Actions
description: What changes in your GitHub Actions workflows, what stays the same, and which jobs you can route.
sidebar:
  label: GitHub Actions
---

Every routed job still runs on GitHub Actions. The only thing that changes is which runner picks it up.

## What changes

Each job you route gets a relay job in front of it, and its `runs-on` reads the relay's answer. Here's a complete workflow with `test` routed and `lint` left as it was:

```yaml title=".github/workflows/ci.yml" {9-14,17-18}
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  # Picks a runner for the test job: your machines first, then ubuntu-latest.
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1
    with:
      machine: self-hosted
      github: ubuntu-latest

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint
```

`npx relayrunner init` makes this change for you. See [Move your workflows over](/docs/get-started/move-over).

## What stays the same

- Your workflow files, the events that start them, and your steps.
- Check names, so required checks and branch protection keep working.
- Logs, artifacts and re-runs, which all stay in GitHub.
- Secrets, which go from GitHub straight to the runner.

## Minutes

The relay job finishes in about a second without a runner, so it uses no minutes. Jobs on your own machines don't use GitHub minutes either. Jobs that go to GitHub-hosted runners use your included minutes as usual. See [Spend controls](/docs/guides/spend-controls).

## What you can't route yet

- **Matrix jobs.** One relay routes one job.
- **Reusable workflows.** They choose their own runner.
- **Windows jobs**, and GitHub Enterprise Server.
- **Public repos on your machines.** Public repos can still route between hosted providers.

## Next

- [Quickstart](/docs/get-started/quickstart): connect a machine and route your first job.
- [How routing works](/docs/concepts/routing): how the relay picks a runner.
