---
title: Security
description: What RelayRunner can and can't do with your code and machines.
---

## What runs on your machine

A routed job runs in `actions/runner`, GitHub's official runner, as the user who started `relayrunner connect`. The runner talks to GitHub directly for the job's code, secrets and logs. None of it passes through RelayRunner.

The job isn't sandboxed. Like any self-hosted runner, it can read and write what that user can, including files in your home folder. So:

- Route jobs only from repos you trust to run on that machine.
- For a shared or always-on machine, run `connect` as a separate user, or use isolated jobs.
- Keep deploy jobs, which carry production secrets, off machines unless you mean to. `init` skips them for this reason.

## Isolated jobs

On a Mac with Apple silicon, `relayrunner connect --isolated` runs each job in its own Linux VM instead. It's experimental. In the VM, a job:

- Sees none of your files, and not the machine's token.
- Starts clean. Nothing an earlier job left behind is there, and the VM is deleted when the job ends.
- Reaches the internet, but not your Mac or your local network. `--local-network` turns this off. A job that sets out to remove this block can, through Docker. Run `relayrunner firewall on` once to add a firewall on the Mac that no job can remove.

See [Isolated jobs on a Mac](/docs/runners/self-hosted#isolated-jobs-on-a-mac).

## One job per runner

Each job gets a fresh runner registered for that job alone, and removed when it ends. There's no long-lived runner registration to steal. The terminal shows which repo each job comes from.

## Public repositories

Machines never take a public repo's jobs. Anyone can open a pull request to a public repo, and that would let them run code on your machine. Public repos can still use relays to choose between hosted providers.

## Who can send jobs to a machine

- **Only me** (the default): only jobs you started.
- **Anyone**: any job in the workspace, from a repo the machine's owner can open on GitHub. Sharing never gives a machine code its owner couldn't already see.

## Machine tokens

Each machine signs in with its own token, which changes every time `connect` comes online. If someone else signs in with it, the person who approved the machine gets an email.

Removing a machine in the dashboard revokes its token straight away.

## The GitHub App

The App can't read your code, apart from `relayrunner.yml`, and never receives job logs or secrets. See [GitHub App](/docs/reference/github-app) for every permission and why.

## Report a vulnerability

Email [security@relayrunner.app](mailto:security@relayrunner.app).
