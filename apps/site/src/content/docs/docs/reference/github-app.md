---
title: GitHub App
description: What the RelayRunner GitHub App can do, and why it asks for each permission.
---

RelayRunner reaches GitHub through one GitHub App, [RelayRunner](https://github.com/apps/relayrunner). It signs you in, receives workflow events, and registers the one-job runners that answer relays and run jobs on your machines. Install it on each organization or personal account you want to route.

## Repository permissions

| Permission     | Access                               | Why                                                                                                                                                          |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Administration | Read & write                         | Registers one-job runners on the job's own repo, so only that repo's jobs can reach them. Lists and labels repo runners you add.                             |
| Actions        | Read & write                         | Workflow job and run events, and checking whether a relay job is still queued. Write re-runs jobs for automatic retries and is reserved for cancelling jobs. |
| Checks         | Read & write                         | The PR title and description checks, a check run that explains a relay that can't be answered, and reading why a job's runner failed.                        |
| Contents       | Read & write, `relayrunner.yml` only | Reads [repo config](/docs/reference/repo-config). Write is reserved for saving it from the dashboard. It can't touch any other file.                         |
| Pull requests  | Read                                 | Pull request events for the PR title and description checks.                                                                                                 |
| Metadata       | Read                                 | Required by GitHub for every App.                                                                                                                            |

## Organization permissions

| Permission          | Access       | Why                                                                                                                                                                             |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted runners | Read & write | Registers one-job runners in the org when a repo runner isn't allowed, and lists and labels [existing runners](/docs/runners/self-hosted#runners-your-org-already-has) you add. |
| Administration      | Read         | Reads your plan, Actions usage and budget for the [minutes limit](/docs/concepts/runner-order#the-minutes-limit). It can't change any setting.                                  |

## Enterprise permissions

| Permission         | Access | Why                                                                                                                                              |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enterprise billing | Read   | Your enterprise's shared Actions minutes, for the minutes limit. Only used if an enterprise owner [installs it on the enterprise](#enterprises). |

## Account permissions

| Permission      | Access | Why                                                        |
| --------------- | ------ | ---------------------------------------------------------- |
| Email addresses | Read   | Your email at sign-in.                                     |
| Plan            | Read   | A personal account's Actions usage, for the minutes limit. |

## Enterprises

An org in a GitHub enterprise shares the enterprise's Actions minutes, and GitHub only reports those to the enterprise. To use a minutes limit there, an enterprise owner installs the App on the enterprise too: open [the install page](https://github.com/apps/relayrunner/installations/new) and pick the enterprise. Settings > GitHub links there when it's needed.

That install only reads the enterprise's billing. It sees no repos, and your org installs keep doing the routing. Each org in the enterprise is then judged against the shared minutes.

## What it never gets

The App can't read your code, beyond `relayrunner.yml`, and doesn't receive repository secrets. It reads a job's log through Actions read only to show why a failed job failed, or to send it to your own endpoint or bucket when you turn on [job logs](/docs/dashboard/telemetry#job-logs) or a [log archive](/docs/dashboard/telemetry#log-archive), and never stores it. Jobs that run on your machines use GitHub's own runner, which talks to GitHub directly.

## Runner groups

If your org's runner group settings block RelayRunner's runners, it posts a failed `RelayRunner` check on the commit that says what to change. **Route a repo** on the Router page also marks the repos your org's Default runner group leaves out, before you route them.

## RelayRunner Checks

Lint uses a second, optional App, **RelayRunner Checks**, with Contents read, Checks write and Pull requests read. It lints each commit in a sandbox with no internet access, then discards it. Install it only if you want lint.

## RelayRunner Spend

An optional App, [RelayRunner Spend](https://github.com/apps/relayrunner-spend), reads billing on its own. Its only permission is Organization administration (read). You don't need it unless the dashboard asks for it.

## When permissions change

When the App asks for a new permission, GitHub asks each account to accept it under **Settings → GitHub Apps**. Features that need it start working once it's accepted.
