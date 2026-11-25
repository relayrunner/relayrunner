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
      os: linux
      cpus: 4

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
```

## What the job needs

Say what the job needs, and every provider in your runner order can take it. Each hosted provider gets its smallest runner that fits, and a machine fits when it has the OS and enough cores.

| Input  | Default             | What it is                                                                                                                                                       |
| ------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `os`   | `linux`             | `linux`, `macos` or `windows`.                                                                                                                                   |
| `arch` | the OS's usual arch | `x64` or `arm64`. Left out, hosted providers use x64 for Linux and Windows and Apple silicon for macOS, and your machines fit whatever their arch.               |
| `cpus` | the Router page     | The fewest CPUs the job needs. Left out, the job uses the size you pick for it on the Router page (see [Auto sizes](#auto-sizes)), and machines fit at any size. |

```yaml
with:
  os: macos
  cpus: 6
```

- **A provider with nothing that fits is skipped**, such as one with no macOS runners, or GitHub-hosted for a job that needs more than its standard runners. The Activity page says why.
- **GitHub-hosted counts its standard runners only:** 2 vCPU on private repos and 4 on public ones for Linux, Arm and Windows, and 3 for macOS. Name a larger runner's label in `github` to use it.
- **A machine running jobs in a VM** fits when the VM's size meets `cpus`.
- **Shape inputs need relay.yml 1.0.0 or later**, which `@v1` follows.

## Exact labels

To use a specific runner, give the provider's input. With `os`, `arch` or `cpus` set, that provider uses your label as written and the other providers are still sized for the job; a `machine` label must also have the OS and arch you set. Without them, only the providers you name can take the job, and a provider you leave out is never used, even if it's in your runner order.

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
| `boat`       | none    | One Boat label, such as `boat` or `boat-large`.                                                                                                                                                              |
| `starsling`  | none    | One StarSling label, such as `starsling-ubuntu-24.04-2`. Organizations' repos only.                                                                                                                          |
| `monkci`     | none    | One Monk CI label, such as `monkci-ubuntu-24.04-2`. Organizations' repos only.                                                                                                                               |
| `runloft`    | none    | One Runloft label, such as `runloft-ubuntu-24.04`.                                                                                                                                                           |
| `latchkey`   | none    | One Latchkey label, such as `latchkey-small`. Organizations' repos only.                                                                                                                                     |
| `berrybox`   | none    | One BerryBox label, such as `berrybox-2vcpu-ubuntu-2404`. Organizations' private repos only.                                                                                                                 |
| `celesto`    | none    | One Celesto label, such as `celesto-standard`.                                                                                                                                                               |
| `instabox`   | none    | One InstaBox label, such as `instabox-medium`.                                                                                                                                                               |
| `lizard`     | none    | One Lizard label, such as `lizard-medium-ubuntu-2404`. Organizations' repos only.                                                                                                                            |
| `groundbox`  | none    | One Groundbox label, such as `groundbox-4vcpu`, `groundbox-windows-4vcpu` or `groundbox-macos`.                                                                                                              |
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

- **The size** is the one you picked for the job on the Router page, or the workspace's **Default size** under **Settings** there. It starts at 2 vCPU. To pick one, find the workflow under **Workflows** and click its auto jobs. For a repo that isn't routed yet, pick sizes in **Route a repo** on the same page; they apply from the first run.
- **A provider without that size** uses its next size up. If it has nothing that big, the job skips it, and the Activity page says why. GitHub-hosted has standard runners up to 2 vCPU.
- **Try first**, next to the size, sends one job to a provider before the rest of your runner order. When the provider is in the order more than once, only its first step moves up, and its later steps stay where they are.
- A workflow whose relays all name their labels shows as **Pinned** under Workflows. Its sizes stay in the file.
- Auto sizes are Linux x64 unless the relay sets `os` or `arch`.

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
