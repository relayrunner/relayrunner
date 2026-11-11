---
title: Install the CLI
description: Getting the relayrunner CLI onto a machine, and signing it in.
sidebar:
  label: Install
---

The `relayrunner` CLI connects a machine to your workspace and routes a repo's jobs. It runs on macOS and Linux, on x64 or ARM64, with Node.js 22 or newer. Windows isn't supported yet.

## Install

Run it with `npx`, with nothing to install:

```sh
npx relayrunner connect
```

Or install it globally:

```sh
npm install --global relayrunner
relayrunner --help
```

## Sign in

There are two ways to sign a machine in. Both open the dashboard, where you sign in with GitHub, pick the workspace and name the machine.

- **`relayrunner connect`** signs in and puts the machine online in one go. Use this on a machine you'll run jobs on now.
- **`relayrunner login`** signs in and exits, without putting the machine online. Coding agents use this, since they can't keep `connect` running after their session ends.

Check who the machine is signed in as with `relayrunner whoami`.

The machine's token is saved to `~/.relayrunner/machine.json`.

## Keep it running

`connect` is the on/off switch. Leave it open in a terminal tab while you want the machine to take jobs. It reconnects on its own if the network drops.

To stop taking new jobs without going offline, run `relayrunner pause`, or press `p` in the `connect` terminal. `relayrunner resume` undoes it.

## Update

`npx relayrunner` always fetches the latest version. For a global install, run `npm install --global relayrunner@latest`.

See the [CLI reference](/docs/reference/cli/) for every command and flag.
