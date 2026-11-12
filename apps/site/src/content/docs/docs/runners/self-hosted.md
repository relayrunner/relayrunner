---
title: Your machines
description: Running jobs on computers you own, connected with the CLI.
---

Any Mac or Linux computer can take jobs: your laptop, a Mac mini under the desk, an old gaming PC, a home server. Connect it with the CLI and it joins the self-hosted step of every workspace you're in.

## Connect a machine

```sh
npx relayrunner connect
```

The first run signs the machine in. After that, the machine is online while `connect` runs, and the terminal shows each job as it runs. Ctrl-C takes it offline.

Jobs run in GitHub's official runner, set up fresh for each job. The machine needs no runner setup of its own.

Where a job runs depends on the machine:

- **On a Mac with Apple silicon**, each job runs in its own Linux VM, away from your files. See [Isolated jobs on a Mac](#isolated-jobs-on-a-mac).
- **On Linux or an Intel Mac**, jobs run on the machine itself, as the user who started `connect`.

## Labels

Every machine has the label `self-hosted`, plus the OS and architecture its jobs run on: `macOS` or `Linux`, and `ARM64` or `X64`. A Mac that runs jobs in Linux VMs has the label `Linux`, and `macOS` too when you connect it with `--macos`. A relay's `machine` input lists the labels a machine must have, all of them:

| `machine:`    | Runs on                                       |
| ------------- | --------------------------------------------- |
| `self-hosted` | Any machine                                   |
| `Linux`       | Linux machines, and Macs that run jobs in VMs |
| `macOS`       | Macs that take macOS jobs                     |
| `Linux, X64`  | Intel or AMD Linux machines                   |

## Who can run jobs on it

A new machine only runs jobs you started (**only me**). To let teammates' and bots' jobs run on it too, share it with **anyone** in the workspace:

```sh
relayrunner share anyone    # or only-me
```

You can also change it from the sharing icon on the machine's card on the **Runners** page. Only the machine's owner can change it.

"Anyone" only covers jobs from repos the machine's owner can open on GitHub, so sharing a machine never gives it code you couldn't already see. See [Share your team's machines](/docs/guides/team-machines).

## Pause

Pausing keeps a machine connected but stops new jobs reaching it. A job it's already running finishes.

```sh
relayrunner pause
relayrunner resume
```

Press `p` in the `connect` terminal, or use the machine's ⋯ menu on the Runners page. Anyone in the workspace can pause a machine.

## Jobs at once

A machine runs up to 2 jobs at once when it has 8 or more CPU cores, otherwise 1. Change it with `relayrunner connect --concurrency <n>`. Each job gets its own VM or its own copy of the runner, so jobs never share a workspace. When every slot is busy, the next job goes to another machine or falls through to the next step in your runner order.

## Isolated jobs on a Mac

On a Mac with Apple silicon, each job runs in its own Linux VM. The VM sees none of your files, can reach the internet but not your Mac or your local network, and is deleted when the job ends.

You need macOS 26 and Apple's [container](https://github.com/apple/container/releases) tool, started once with `container system start`. Without it, `connect` still works: jobs run on the Mac itself, where they can read your files, and `connect` tells you so each time it starts.

The first run takes a couple of minutes to prepare the image jobs start from. After that a VM starts in a few seconds.

### What's in the VM

The VM has the everyday tools a job written for `ubuntu-latest` expects: Git and Git LFS, Docker with Compose and Buildx, Node with npm, Python with pip, compilers and `make`, `curl`, `wget`, `jq`, `zip` and the `gh` CLI. Jobs with `services:` or `container:` run too.

For a specific version of Node or Python, or another language such as Go, Java, Ruby or Rust, use its `setup-*` action as you would on GitHub. The VM is ARM, so a job that needs x64 binaries should stay on `ubuntu-latest`.

To start from your own runner image, pass `--image <image>`. Your image is used with the tools it has.

### macOS jobs

In a VM, jobs run on Linux, so the Mac's labels are `Linux` and `ARM64` and it takes jobs written for `ubuntu-latest`. To take macOS jobs such as Xcode builds too, add `--macos`:

```sh
npx relayrunner connect --macos
```

Linux jobs still run in a VM. macOS jobs run on the Mac itself, as you, so route them only from repos you trust. A job that names neither OS goes by its GitHub fallback, so one written for `ubuntu-latest` runs in the VM.

### The size of each job

Each VM gets an even share of the Mac's CPU cores, and of half its memory, so the Mac stays usable while jobs run. A Mac with 14 cores and 36 GB running 2 jobs at once gives each job 7 CPUs and 9 GB.

To give every job a fixed size, like a hosted runner's, set it:

```sh
npx relayrunner connect --cpus 4 --memory 16
```

That runs as many 4 CPU, 16 GB jobs at once as fit. `--concurrency` still sets the number yourself. A core on an Apple silicon Mac is faster than a hosted runner's vCPU, so the same size usually finishes sooner here.

### Your network

A job can't reach your Mac or your local network. If it needs something there, such as a package registry or a test database, add `--local-network`. The job still can't read your files.

This block runs inside the VM, where a job that uses Docker could remove it. For a block no job can remove, run `relayrunner firewall on` once. It asks for your password, stays on after a restart, and `relayrunner firewall off` removes it. While it's on, `--local-network` has no effect.

### Run jobs on the Mac itself

`--no-isolated` runs every job on the Mac, as you, with the tools you have installed. Jobs can read your files, so route them only from repos you trust.

```sh
npx relayrunner connect --no-isolated
```

### When something goes wrong

`~/.relayrunner/isolated.log` has the details. It records the VM commands and their results, never a job's output or credentials, so it's safe to share. `connect` removes the images it downloaded for older runner versions, so they don't fill your disk.

## Remove a machine

Remove it from the Runners page. You can remove your own machines; owners and admins can remove any. When someone leaves a workspace, their machines stay theirs and stop taking its jobs.

## Runners your org already has

If your organization already runs self-hosted runners, you can route jobs to them as they are, with no change on the runner's machine. On the **Runners** page, choose **Add runners from GitHub** and pick the ones to add. Owners and admins can add them, and only for organizations.

Added runners share the self-hosted step with your connected machines, and are picked the same way: online, idle, and with every label in the relay's `machine` input. Removing one from RelayRunner leaves it registered on GitHub.

## Public repos

Machines never run a public repo's jobs. See [Principles](/docs/concepts/principles).
