---
title: Overview
description: RelayRunner routes each GitHub Actions job to the first runner in your list that can take it, from your own machines to hosted runners.
---

RelayRunner is a router for GitHub Actions. You tell it which runners a job may use, and it sends each job to the first one in your list that can take it right now: your laptop when it's online and free, a self-hosted runner your org already has, a hosted provider such as Blacksmith or Depot, or GitHub's hosted runners.

Your workflows stay the same. Checks keep their names, logs stay in GitHub, and you change where jobs go from the dashboard, not with a commit.

## Why use it

- **Your minutes ran out.** Coding agents push all day, and a plan's included minutes are gone before the month is. Send jobs to a machine you already own first, and keep GitHub as the fallback.
- **Your bill spiked.** Use your included minutes, then switch to your own machines before you pay overage.
- **macOS builds cost 10x.** Run them on the Mac on your desk, and fall back to hosted Macs when it's asleep.
- **One spare machine isn't enough.** A home server or old laptop is free but becomes a queue. RelayRunner only sends it a job when it's idle and hands the rest to hosted runners.

## How it fits together

- **Workspace.** Your team in RelayRunner. It connects one or more GitHub organizations or personal accounts through the RelayRunner GitHub App.
- **Runners.** Where jobs can run: machines you connect with the CLI, self-hosted runners you already have, hosted providers and GitHub-hosted runners. See [Providers](/docs/runners/providers/).
- **Relay job.** A small job you add in front of each job you want routed. It names the runners that job may use. RelayRunner answers it in about a second, with no runner and no billed minutes. See [Routing](/docs/concepts/routing/).
- **Runner order.** The order the workspace tries runners in, set on the dashboard's Router page. See [Runner order](/docs/concepts/runner-order/).

```yaml
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1
    with:
      machine: self-hosted # any machine in your workspace
      github: ubuntu-latest # when no machine is free

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

Each job on a machine gets a fresh one-job runner, so nothing is left behind between jobs. Public repositories never run on your machines.

## Next

- [Quickstart](/docs/get-started/quickstart/): a green job on your own machine in a few minutes.
- [Principles](/docs/concepts/principles/): the rules RelayRunner routes by.
