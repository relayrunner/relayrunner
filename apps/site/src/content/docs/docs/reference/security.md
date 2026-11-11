---
title: Security
description: What RelayRunner can and can't do with your code and machines.
---

## What runs on your machine

A routed job runs in `actions/runner`, GitHub's official runner, as the user who started `relayrunner connect`. The runner talks to GitHub directly for the job's code, secrets and logs. None of it passes through RelayRunner.

The job isn't sandboxed. Like any self-hosted runner, it can read and write what that user can, including files in your home folder. So:

- Route jobs only from repos you trust to run on that machine.
- For a shared or always-on machine, run `connect` as a separate user, or in a VM.
- Keep deploy jobs, which carry production secrets, off machines unless you mean to. `init` skips them for this reason.

## One job per runner

Each job gets a fresh runner registered for that job alone, on the job's own repo, and removed when it ends. There's no long-lived runner registration to steal, and nothing from one job's runner is reused for the next.

Before starting a job, the CLI checks that its runner config only points at GitHub's servers over https and is named for that job. Anything else is refused. The terminal shows which repo each job comes from.

## Public repositories

Machines never take a public repo's jobs. Anyone can open a pull request to a public repo, and that would let them run code on your machine. Public repos can still use relays to choose between hosted providers.

## Who can send jobs to a machine

- **Only me** (the default): only jobs you started, both the run and the attempt.
- **Anyone**: any job in the workspace, from a repo the machine's owner can open on GitHub. Sharing never gives a machine code its owner couldn't already see.

## Machine tokens

A machine's token is stored only as a hash. A new token is issued each time `connect` comes online, and the old one stops working, so a copied `machine.json` can't sign in for long. If another copy signs in while the machine is online, the person who approved the machine gets an email.

Removing a machine in the dashboard revokes its token straight away.

## The GitHub App

The App can't read your code, apart from `relayrunner.yml`, and never receives job logs or secrets. See [GitHub App](/docs/reference/github-app/) for every permission and why.

## Report a vulnerability

Email [security@relayrunner.app](mailto:security@relayrunner.app).
