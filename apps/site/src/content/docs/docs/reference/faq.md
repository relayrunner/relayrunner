---
title: FAQ
description: Common questions about RelayRunner.
---

## Is RelayRunner free?

Yes. It's open source, and the core routing will stay that way. We plan to add a paid tier later for advanced management, aimed at larger teams. Nothing you set up now will need to change.

## Do I pay RelayRunner for runner minutes?

No. Your machines are yours, and hosted providers bill you directly under your own accounts. A routed job only gets a label.

## Do relay jobs use minutes?

No. A relay job finishes in about a second, without a runner. Optimized checks don't use minutes either.

## What happens when my laptop is closed?

Jobs go to the next step in your runner order, usually GitHub-hosted, with nothing to change. A job that was running when it closed stops, and re-running it routes it again.

## Do I need to keep a terminal open?

Yes, `relayrunner connect` is the on/off switch. While it runs, the machine takes jobs.

## Does it work with public repositories?

Public repos can use relays to choose between hosted providers, and optimized checks. Their jobs never run on your machines.

## Does it work on Windows?

Not yet. Machines can be macOS or Linux, on x64 or ARM64.

## Can I use it with GitHub Enterprise Server?

Not yet. It works with organizations and personal accounts on github.com.

## Can a job run on several machines at once, like a matrix?

Not through one relay. Each relay routes one job, so matrix jobs aren't routed. Give separate jobs their own relays.

## Can my teammates' jobs run on my laptop?

Only if you share it with **anyone**. A new machine only runs jobs you started.

## Does RelayRunner see my code or secrets?

No. Jobs on your machines use GitHub's own runner, which talks to GitHub directly. See [Data and privacy](/docs/reference/privacy).

## Can I run RelayRunner myself?

The code is on [GitHub](https://github.com/relayrunner/relayrunner). The hosted service at app.relayrunner.app is the supported way to use it today.

## What providers does it support?

It routes to your own machines, existing self-hosted runners, GitHub-hosted runners, and hosted providers such as Blacksmith, Depot and Namespace. See [Providers](/docs/runners/providers).
