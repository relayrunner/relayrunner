---
title: Quickstart
description: Shortest path from sign-up to a green job on your own machine.
---

You need a private GitHub repository, and a Mac or Linux computer with Node.js 22 or newer.

## 1. Connect your machine

In a terminal on the computer you want CI on, run:

```sh
npx relayrunner connect
```

The first run shows a code and opens the dashboard. Sign in with GitHub, create a workspace, install the [RelayRunner GitHub App](https://github.com/apps/relayrunner) on your organization or personal account, check the code matches and approve the machine.

Leave `connect` running. While it runs, the machine is online and takes jobs. Ctrl-C takes it offline.

## 2. Route a job

In another terminal, inside a checkout of your repository, run:

```sh
npx relayrunner init
```

`init` lists the repo's jobs and lets you pick which to route. For each one it adds a relay job in front and points the job's `runs-on` at the relay's answer. The job's old label, such as `ubuntu-latest`, becomes the fallback. It only edits `.github/workflows/` and never commits. See [Move your workflows over](/docs/get-started/move-over) for what it changes and what it skips.

:::tip
If you run `connect` inside the repository, it offers to do this step for you.
:::

## 3. Push and watch

Commit the change and push. In the workflow run on GitHub you'll see `relay-<job> / RelayRunner` finish in about a second, then your job start. The terminal running `connect` shows the job as it runs.

Open **Activity** in the [dashboard](https://app.relayrunner.app) to see where the job ran and why. Stop `connect`, push again, and the same job runs on its old label instead.

## Next

- [Runner order](/docs/concepts/runner-order): choose what's tried first.
- [Run CI on your laptop while you work](/docs/guides/laptop-ci): the full laptop setup.
- [Set up with an agent](/docs/get-started/agents): let a coding agent do all of this.
