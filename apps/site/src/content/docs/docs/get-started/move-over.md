---
title: Move your workflows over
description: What relayrunner init changes in your GitHub Actions workflows, and which jobs it leaves alone.
---

Routing a job through RelayRunner is one change: a relay job in front of it, and a `runs-on` that points at the relay's answer. `relayrunner init` makes that change for you.

## Run init

Inside a checkout of the repo:

```sh
npx relayrunner init
```

It sorts every job into three groups and lets you pick from the first:

- **Ready.** The job uses a plain GitHub-hosted label (`ubuntu-*`, `macos-*`) or a hosted provider's label, such as `blacksmith-*` or `depot-*`. Warnings flag what to check first, such as a job that needs Docker when your machine doesn't run jobs in a VM.
- **Already routed.** The job already runs where a relay sends it.
- **Skipped, with the reason.** See below.

To see the list without changing anything, run `relayrunner init --plan`. To route jobs without prompts, run `relayrunner init --apply test,lint`, or `--apply all` for every ready job. Add `--exact` to keep each job on its old label instead of writing its shape.

## Route repos from the dashboard

On the dashboard's Router page, **Route a repo** takes you through one repo at a time:

1. Pick a repo. Repos your org's Default runner group leaves out are marked, with the fix.
2. Pick its jobs from recent runs, and a size for each if you want one other than the default.
3. Copy a prompt for your coding agent, which runs `init`, offers to add [pull request checks](/docs/concepts/optimized-checks) if the repo has no `relayrunner.yml`, and opens a PR. Or copy the `init` command.

After you copy, the sheet waits for the repo's first routed run and says when it's routed. **Next repo** moves on, and from the second repo one prompt can cover the rest.

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
      os: linux

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
    steps: ...
```

The relay gets what the job needs, read from its old label, so any runner on your Router page can take it: your machines first, then your runner order.

| Old label                      | Relay inputs               |
| ------------------------------ | -------------------------- |
| `ubuntu-latest`                | `os: linux`                |
| `ubuntu-24.04-arm`             | `os: linux`, `arch: arm64` |
| `macos-15`                     | `os: macos`                |
| `macos-13`                     | `os: macos`, `arch: x64`   |
| `blacksmith-8vcpu-ubuntu-2404` | `os: linux`, `cpus: 8`     |

`cpus` only appears when the label asks for more than a standard 2 CPU runner. Without it, you set the job's size on the Router page, with no commit. See [relay.yml inputs](/docs/reference/relay-inputs).

`init` keeps your comments and formatting, and never commits.

Push the change. The check keeps its name in GitHub, so required checks and branch protection keep working.

## Jobs it skips

- **Deploy jobs.** Jobs that use secrets, a deploy environment, or an OIDC token to sign in to a cloud or publish a package. Running one on a machine gives that machine those secrets, so it's your call. To route one anyway, add `--allow-deploy <job>`. A job that only requests an OIDC token, such as for a remote cache, isn't skipped.
- **Jobs pinned to a label list or runner group**, such as `runs-on: [self-hosted, m1, macmini]`. The relay falls back to one label, so to route one by hand, pick what kind of machine may take it (`machine: macOS, ARM64`) and a hosted label for when none is free.
- **Matrix jobs.** One relay answers one job, so it can't serve every leg of a matrix.
- **Reusable workflows.** They choose their own runner.
- **Windows jobs**, and jobs on a single `self-hosted` label.

## Public repos

`init` refuses public repositories, since their jobs [never run on your machines](/docs/concepts/principles#public-repositories-never-run-on-your-machines).

## Undo

Delete the relay job and put the old label back in `runs-on`. Or leave the change in place: with no machine online and GitHub in your runner order, jobs run on their old label anyway.
