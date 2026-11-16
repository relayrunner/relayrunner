---
title: relay.yml inputs
description: Every input and output of the relay, a reusable GitHub Actions workflow.
---

The relay is a reusable workflow in [relayrunner/actions](https://github.com/relayrunner/actions). Add one in front of each job you want routed.

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
```

## Inputs

Give one input per provider the job may use. A provider you leave out is never used for this job, even if it's in your runner order.

Any input can say `auto` instead of a label. The Router then picks that provider's label for the job's size, which you set on the dashboard's Router page. See [Auto sizes](#auto-sizes).

| Input        | Default | What it is                                                                                                                                                                                                   |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `machine`    | none    | Comma-separated labels a self-hosted machine must have, all of them. `self-hosted` accepts any machine. Narrow it with `macOS`, `Linux`, `ARM64` or `X64`, such as `macOS, ARM64`. Ignored for public repos. |
| `github`     | none    | One GitHub-hosted label, such as `ubuntu-latest` or `macos-latest`.                                                                                                                                          |
| `blacksmith` | none    | One Blacksmith label, such as `blacksmith-4vcpu-ubuntu-2404`.                                                                                                                                                |
| `depot`      | none    | One Depot label, such as `depot-ubuntu-24.04`.                                                                                                                                                               |
| `namespace`  | none    | One Namespace label, such as `namespace-profile-default`.                                                                                                                                                    |
| `warpbuild`  | none    | One WarpBuild label, such as `warp-ubuntu-latest-x64-2x`.                                                                                                                                                    |
| `ubicloud`   | none    | One Ubicloud label, such as `ubicloud-standard-2`.                                                                                                                                                           |
| `runs-on`    | none    | One RunsOn label, such as `runs-on=${{ github.run_id }}/runner=2cpu-linux-x64`.                                                                                                                              |

## Auto sizes

With `auto`, you change a job's size on the dashboard instead of in the workflow file:

```yaml
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1
    with:
      machine: auto
      blacksmith: auto
      github: auto
```

| Input                                      | What the job gets                                      |
| ------------------------------------------ | ------------------------------------------------------ |
| `blacksmith: auto`                         | Blacksmith's runner for the job's size                 |
| `blacksmith: blacksmith-4vcpu-ubuntu-2404` | That label, as written                                 |
| `machine: auto`                            | Any of your machines, at its own size                  |
| No inputs at all                           | Every provider in your runner order, at the job's size |

- **The size** is the one you picked for the job under **Workflows** on the Router page, or the workspace's **Default size** under **Settings** there. It starts at 2 vCPU.
- **A provider without that size** uses its next size up. If it has nothing that big, the job skips it, and the Activity page says why. GitHub-hosted has standard runners up to 2 vCPU.
- **Try first** on the Router page sends one job to a provider before the rest of your runner order.
- Auto sizes are for Linux x64. For macOS, Windows or Arm, write the label.

## Output

| Output   | What it is                                    |
| -------- | --------------------------------------------- |
| `runner` | The label to put in the next job's `runs-on`. |

## Requirements

- The [RelayRunner GitHub App](https://github.com/apps/relayrunner) is installed on the repo's owner and connected to a workspace.
- If your organization limits which actions and reusable workflows can run, allow `relayrunner/actions/*`.

## Versions

`@v1` gets fixes and new features without breaking changes. See [releases](https://github.com/relayrunner/actions/releases).

## Good to know

- **One relay per job.** Jobs that share one relay's output won't all run. Give each job its own relay.
- **It shows as `relay-<job> / RelayRunner`** in the workflow run, and finishes in about a second.
- **No minutes.** The relay runs on `runs-on: relayrunner`, which needs no runner. Don't give any runner of your own the `relayrunner` label, or it may take relays instead.
