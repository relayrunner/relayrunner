---
title: relay.yml inputs
description: Every input and output of the relay workflow.
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
- **No minutes.** The relay is answered on `runs-on: relayrunner`, without a runner. Don't give any runner of your own the `relayrunner` label, or it may take relays instead.
