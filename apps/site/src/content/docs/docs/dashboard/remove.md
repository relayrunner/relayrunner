---
title: Remove RelayRunner
description: Switching jobs back, disconnecting machines and uninstalling the GitHub App.
sidebar:
  label: Remove
---

You can stop using RelayRunner at any time. Here's how to undo each part.

## 1. Switch your jobs back

For each routed job, delete its `relay-<job>` job and put the label from the relay's `github` (or `blacksmith`) input back in `runs-on`:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps: ...
```

Do this before uninstalling the App. A relay job with nobody to answer it stays queued until GitHub cancels it after 24 hours.

To pause routing without editing workflows, stop every machine and keep GitHub-hosted in the runner order. Jobs then run on their old labels.

## 2. Disconnect your machines

Stop `relayrunner connect` on each machine and remove it from the **Runners** page. To delete the CLI's files, remove `~/.relayrunner`.

## 3. Remove added runners

Remove any [existing runners](/docs/runners/self-hosted#runners-your-org-already-has) you added. This takes the RelayRunner label off them. The runners stay registered in your org.

## 4. Uninstall the GitHub Apps

On GitHub, go to your organization's or account's **Settings → GitHub Apps** and uninstall **RelayRunner**, and **RelayRunner Checks** if you installed it.

## 5. Delete your data

Email [privacy@relayrunner.app](mailto:privacy@relayrunner.app) to have your account and workspace data deleted. See [Data and privacy](/docs/reference/privacy).
