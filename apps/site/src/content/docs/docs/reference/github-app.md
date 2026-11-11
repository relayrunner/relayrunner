---
title: GitHub App
description: What the RelayRunner GitHub App can do, and why it asks for each permission.
---

RelayRunner reaches GitHub through one GitHub App, [RelayRunner](https://github.com/apps/relayrunner). It signs you in, receives workflow events, and registers the one-job runners that answer relays and run jobs on your machines. Install it on each organization or personal account you want to route.

## Repository permissions

| Permission     | Access                       | Why                                                                                       |
| -------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| Administration | Read & write                 | Registers one-job runners on the job's own repo, so only that repo's jobs can reach them. |
| Actions        | Read                         | Workflow job and run events, and checking whether a relay job is still queued.            |
| Checks         | Read & write                 | The PR title check, and a check run that explains a relay that can't be answered.         |
| Contents       | Read, `relayrunner.yml` only | Reads [repo config](/docs/reference/repo-config). It can't read any other file.           |
| Pull requests  | Read                         | Pull request events for the PR title check.                                               |
| Metadata       | Read                         | Required by GitHub for every App.                                                         |

## Organization permissions

| Permission          | Access       | Why                                                                                                                                                                             |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted runners | Read & write | Registers one-job runners in the org when a repo runner isn't allowed, and lists and labels [existing runners](/docs/runners/self-hosted#runners-your-org-already-has) you add. |
| Administration      | Read         | Reads the org's plan and Actions usage for the [minutes limit](/docs/concepts/runner-order#the-minutes-limit).                                                                  |

## Account permissions

| Permission      | Access | Why                                                        |
| --------------- | ------ | ---------------------------------------------------------- |
| Email addresses | Read   | Your email at sign-in.                                     |
| Plan            | Read   | A personal account's Actions usage, for the minutes limit. |

## What it never gets

The App can't read your code, beyond `relayrunner.yml`. It doesn't receive job logs or repository secrets. Jobs that run on your machines use GitHub's own runner, which talks to GitHub directly.

## Runner groups

If your org's runner group settings block RelayRunner's runners, it posts a failed `RelayRunner` check on the commit that says what to change.

## RelayRunner Checks

Lint uses a second, optional App, **RelayRunner Checks**, with Contents read, Checks write and Pull requests read. It lints each commit in a sandbox with no internet access, then discards it. Install it only if you want lint.

## When permissions change

When the App asks for a new permission, GitHub asks each account to accept it under **Settings → GitHub Apps**. Features that need it start working once it's accepted.
