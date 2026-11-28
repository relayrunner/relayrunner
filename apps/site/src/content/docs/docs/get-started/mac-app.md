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

While it's on, the Mac takes jobs, each in its own Linux VM. The head is faded while the Mac isn't taking jobs and shows a dot while a job runs.

### The menu

The menu has a switch to turn the Mac on and off, with a line beside it that says what it's doing: waiting for jobs, how many are running and waiting, or when a pause ends.

Each running job shows its name, workflow and repo, how long it has run and a bar against how long it usually takes on this Mac, with about how long it has left. The bar turns orange once the job is clearly slower than usual.

Below that are **Pause New Jobs**, **Jobs…**, **Open Dashboard**, **Settings…** and **Quit RelayRunner**.

### Jobs window

**Jobs…** (⌘J while the menu is open) lists the jobs running or waiting on this Mac, then every job it ran in the last week. Filter by result, repo, workflow and time, or search by name. Pick a job to see its steps on a timeline. A failed job also shows the step that failed, GitHub's annotations, the end of its log and, when the workspace has AI on, the likely cause.

If jobs went to another runner in the last hour because every slot was busy, a note above the list says how many. When the Mac has room for another job, **Allow N Jobs at Once** adds a slot once the running jobs finish. Otherwise the button opens Settings.

### Pause

**Pause New Jobs** stops new jobs for an hour, four hours, until tomorrow morning or until you resume. Running jobs finish first. The menu says when the pause ends, and **Resume New Jobs** ends it early.

## Settings

Settings has the same options as `connect`'s flags: how many jobs run at once, each VM's CPUs and memory, whether the Mac also takes macOS jobs, and whether jobs can reach your local network. See [Isolated jobs on a Mac](/docs/runners/self-hosted#isolated-jobs-on-a-mac) for what each one does.

The **Workspaces** tab picks which workspaces the Mac takes jobs from and who can run them.

## With the CLI

The app and the CLI share their sign-in, so a Mac you already connected with `npx relayrunner connect` is signed in already. Only one of them runs at a time: quit `connect` before you turn the app on. They share their job history too, which [`relayrunner history`](/docs/reference/cli#history) lists.

## Updates

The app checks for updates about once a day and offers to install them. With Homebrew, `brew upgrade --cask relayrunner` works too. To check now, open Settings › About and click **Check for Updates…**. **Show Log** is there too.
