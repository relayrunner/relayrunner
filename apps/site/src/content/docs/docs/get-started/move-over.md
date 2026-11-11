---
title: Move your workflows over
description: What relayrunner init changes in your workflows, and which jobs it leaves alone.
---

Routing a job through RelayRunner is one change: a relay job in front of it, and a `runs-on` that points at the relay's answer. `relayrunner init` makes that change for you.

## Run init

Inside a checkout of the repo:

```sh
npx relayrunner init
```

It sorts every job into three groups and lets you pick from the first:

- **Ready.** The job uses a plain GitHub-hosted label (`ubuntu-*`, `macos-*`) or a hosted provider's label, such as `blacksmith-*` or `depot-*`. Warnings flag what to check first, such as a job that needs Docker or installs Linux packages while your machine is a Mac.
- **Already routed.** The job already runs where a relay sends it.
- **Skipped, with the reason.** See below.

To see the list without changing anything, run `relayrunner init --plan`. To route jobs without prompts, run `relayrunner init --apply test,lint`, or `--apply all` for every ready job.

## What it writes

For a job like this:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps: ...
```

`init` writes:

```yaml
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1
    with:
      machine: self-hosted
      github: ubuntu-latest

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
    steps: ...
```

The old label moves to the relay's `github` input (or the provider's own input, such as `depot`, for a hosted provider's label), so the job still runs there when no machine is free. A `macos-*` job gets `machine: macOS`, so it only goes to Macs. `init` keeps your comments and formatting, and never commits.

Push the change. The check keeps its name in GitHub, so required checks and branch protection keep working.

## Jobs it skips

- **Deploy jobs.** Jobs that use secrets or a deploy environment. Running one on a machine gives that machine those secrets, so it's your call. You can route one by hand with the same change.
- **Matrix jobs.** One relay answers one job, so it can't serve every leg of a matrix.
- **Reusable workflows.** They choose their own runner.
- **Windows jobs**, and jobs already on a self-hosted runner.

## Public repos

`init` refuses public repositories, since their jobs [never run on your machines](/docs/concepts/principles/#public-repositories-never-run-on-your-machines).

## Undo

Delete the relay job and put the old label back in `runs-on`. Or leave the change in place: with no machine online and GitHub in your runner order, jobs run on their old label anyway.
