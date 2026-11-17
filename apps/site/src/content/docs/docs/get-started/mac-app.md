---
title: RelayRunner for Mac
description: A menu bar app that turns your Mac into a GitHub Actions runner with one switch.
sidebar:
  label: Mac app
---

RelayRunner for Mac puts your Mac online from the menu bar, with nothing to keep open in a terminal. It does what `relayrunner connect` does, and the CLI is built in. It needs a Mac with Apple silicon and macOS 14 or newer.

## Install

[Download RelayRunner for Mac](/mac/download), open the DMG and drag RelayRunner to Applications.

Or install it with Homebrew:

```sh
brew install --cask relayrunner/tap/relayrunner
```

If Homebrew asks you to trust the tap first, run `brew trust relayrunner/tap` and try again.

## Turn it on

Click the robot head in the menu bar and turn RelayRunner on. The first time, it asks who can run jobs on this Mac and opens your browser to sign it in, the same as `connect`.

While it's on, the Mac takes jobs, each in its own Linux VM. The head is faded while the Mac isn't taking jobs and shows a dot while a job runs. From the panel you can:

- Turn it on and off.
- Pause new jobs, and let running ones finish.
- See what's running.
- Open the dashboard.

## Settings

Settings has the same options as `connect`'s flags: how many jobs run at once, each VM's CPUs and memory, whether the Mac also takes macOS jobs, and whether jobs can reach your local network. See [Isolated jobs on a Mac](/docs/runners/self-hosted#isolated-jobs-on-a-mac) for what each one does.

The **Workspaces** tab picks which workspaces the Mac takes jobs from and who can run them.

## With the CLI

The app and the CLI share their sign-in, so a Mac you already connected with `npx relayrunner connect` is signed in already. Only one of them runs at a time: quit `connect` before you turn the app on.

## Updates

The app checks for updates about once a day and offers to install them. With Homebrew, `brew upgrade --cask relayrunner` works too.
