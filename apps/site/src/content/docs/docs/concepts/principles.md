---
title: Principles
description: The rules routing follows.
---

RelayRunner sits between your workflows and the places they can run. These are the rules it follows.

## Your workflows don't change

Opting a job in is one change: a relay job and a `runs-on`. After that, everything else happens in the dashboard or the CLI: changing the runner order, adding a machine, pausing one, switching providers. None of it needs a commit.

## Hosted runners stay the fallback

A job that names a hosted label still runs when no machine is free. Your machines add capacity, and CI never waits on them. Close the laptop and jobs run on the next runner in your order.

## No lock-in to one provider

A job lists the runners it may use, and your runner order decides between them. Moving from one provider to another, or adding your own hardware, only means reordering the list. Each provider bills you directly under your own account.

## Public repositories never run on your machines

Anyone can run code on a machine through a pull request to a public repo, so a public repo's job is never sent to one. Public repos can still route between hosted providers.

## Jobs fail with a reason

When no runner fits, the relay fails right away with the reason, such as "No runner available: no self-hosted machine is online and idle". It doesn't leave the job queued.

## One job per runner

Every job on a machine gets a fresh runner that takes that one job and is then removed. Nothing is left behind between jobs, and there's no long-lived runner credential to leak.

## Built for people and agents

The CLI has readable output for people and `--json` for agents, setup is safe to retry, and the docs and dashboard data are available to agents too.
