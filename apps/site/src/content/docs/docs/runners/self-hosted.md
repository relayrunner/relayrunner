---
title: Your machines
description: Running jobs on computers you own, connected with the CLI.
---

Any Mac or Linux computer can take jobs: your laptop, a Mac mini under the desk, an old gaming PC, a home server. Connect it with the CLI and it joins your workspace's self-hosted step.

## Connect a machine

```sh
npx relayrunner connect
```

The first run signs the machine in. After that, the machine is online while `connect` runs. It keeps a connection open to RelayRunner, runs the jobs it's sent one at a time, and prints each one with the repo it came from. Ctrl-C takes it offline.

Each job runs in `actions/runner`, GitHub's official runner, registered for that one job and removed afterwards. The machine needs no runner setup of its own, and nothing is left registered when it's offline.

## Labels

Every machine has the label `self-hosted`, plus its OS and architecture: `macOS` or `Linux`, and `ARM64` or `X64`. A relay's `machine` input lists the labels a machine must have, all of them:

| `machine:`     | Runs on                     |
| -------------- | --------------------------- |
| `self-hosted`  | Any machine                 |
| `macOS`        | Any Mac                     |
| `macOS, ARM64` | Apple silicon Macs          |
| `Linux, X64`   | Intel or AMD Linux machines |

## Who can run jobs on it

A new machine only runs jobs you started (**only me**). To let teammates' and bots' jobs run on it too, share it with **anyone** in the workspace:

```sh
relayrunner share anyone    # or only-me
```

You can also change it from the sharing icon on the machine's card on the **Runners** page. Only the machine's owner can change it.

"Anyone" only covers jobs from repos the machine's owner can open on GitHub, so sharing a machine never gives it code you couldn't already see. See [Share your team's machines](/docs/guides/team-machines/).

## Pause

Pausing keeps a machine connected but stops new jobs reaching it. A job it's already running finishes.

```sh
relayrunner pause
relayrunner resume
```

Press `p` in the `connect` terminal, or use the machine's ⋯ menu on the Runners page. Anyone in the workspace can pause a machine.

## One job at a time

A machine runs one job at a time. When it's busy, the next job goes to another machine or falls through to the next step in your runner order. To run more jobs at once, connect more machines.

## Remove a machine

Remove it from the Runners page. You can remove your own machines; owners and admins can remove any. A running `connect` exits, and the saved token is deleted. A member's machines are removed when they leave the workspace.

## Runners your org already has

If your organization already runs self-hosted runners, RelayRunner can route jobs to them as they are, with no change on the runner's machine. On the **Runners** page, choose **Add runners from GitHub** and pick the ones to add. Owners and admins can add them, and only for organizations.

Added runners share the self-hosted step with your connected machines, and are picked the same way: online, idle, and with every label in the relay's `machine` input. RelayRunner checks each runner's group, so a job is never sent to a runner GitHub won't give it to. Removing one from RelayRunner leaves it registered on GitHub.

## Public repos

Machines never run a public repo's jobs. See [Principles](/docs/concepts/principles/).
