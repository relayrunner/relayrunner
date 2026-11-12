---
title: Troubleshooting
description: Common problems and how to fix them.
---

Start with the **Activity** page in the dashboard. Most routing questions are answered by **Show why** on the job.

## The relay job stays queued

`relay-<job> / RelayRunner` never starts, and nothing shows on the Activity page.

- **The GitHub App isn't installed** on the repo's owner, or doesn't include this repo. Check **Settings → GitHub** in the repo owner's workspace. If the install was a request to an org owner, it needs approving on GitHub first.
- **Your org limits actions.** Allow `relayrunner/actions/*` in the org's Actions settings.
- **A runner group blocks it.** A failed `RelayRunner` check on the commit says what to change.
- **Another runner has the `relayrunner` label.** Remove it, or it may take relays instead of RelayRunner.

A relay nobody answers stays queued until GitHub cancels it after 24 hours. Cancel the run and push again once it's fixed.

## The relay failed with "No runner available"

The message says why each provider couldn't take the job. The usual causes:

- **"no self-hosted machine is online and idle"**: start `relayrunner connect`, or add a `github` fallback to the relay.
- **"is paused"**: resume the machine.
- **"only runs … jobs"**: the machine is shared with **only me**, and someone else started the job. See [sharing](/docs/runners/self-hosted#who-can-run-jobs-on-it).
- **"public repos never run on self-hosted machines"**: give the relay a `github` label.
- **"isn't in your runner order"**: add the provider on the Router page.
- **A minutes limit**: the account is over its limit. Add a step after it.

## The job ran somewhere I didn't expect

Open the job on the Activity page and choose **Show why**. Each skipped step has its reason. Common surprises:

- The machine was busy with another job, so the next step took it.
- A GitHub step with a minutes limit came first and the account was still under it.
- The relay's `machine` labels didn't match, such as `macOS` when the machine is Linux.

## Only the first job ran

Two jobs, or a matrix, share one relay's output. Give each job its own relay.

## The job failed on my machine but passes on GitHub

The machine is missing something the hosted image has: a tool, a Linux package, Docker for `services:` or `container:`. Install it, narrow the relay's `machine` labels, or leave that job on GitHub. On a Mac with Apple silicon, [jobs run in a Linux VM](/docs/runners/self-hosted#isolated-jobs-on-a-mac) with Docker and the everyday tools, like `ubuntu-latest`.

## Isolated jobs on a Mac

- **"Jobs run on this Mac itself"** when `connect` starts: Apple's container tool isn't set up, so jobs aren't isolated. Install it from [its releases page](https://github.com/apple/container/releases), run `container system start`, then start `connect` again.
- **"needs Apple's container tool"** or **"isn't running"**: a flag you passed needs VMs. Install the tool from [its releases page](https://github.com/apple/container/releases) and run `container system start`.
- **"needs macOS 26 or later"** or **"needs a Mac with Apple silicon"**: this computer can't run jobs in VMs. Run `relayrunner connect` without the VM flags.
- **A macOS job never reaches the Mac**: jobs in VMs run on Linux. Add `--macos` to run macOS jobs on the Mac itself.
- **A job can't reach a server on your network**: jobs in VMs are kept off your Mac and local network. Add `--local-network`. If you turned on the firewall on the Mac, also run `relayrunner firewall off`.
- **A job runs out of memory, or is slow**: give each VM more with `--cpus` and `--memory`, or lower `--concurrency`.
- **A job needs a tool the VM doesn't have**: install it in the job, use its `setup-*` action, or pass your own image with `--image`.
- **`ping` fails in a job**: that's expected in a VM. Use `curl` to test a connection.

For anything else, `~/.relayrunner/isolated.log` records what happened. It holds no job output or credentials, so you can attach it to an issue.

## connect says the machine was removed

Someone removed it from the Runners page. Run `relayrunner connect` again to sign in as a new machine.

## Still stuck

Ask in [GitHub issues](https://github.com/relayrunner/relayrunner/issues), or send feedback. See [Feedback](/docs/contribute/feedback).
