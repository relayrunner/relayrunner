---
title: Run CI on your laptop while you work
description: For a solo developer who wants CI on their own computer while they're working, and back on GitHub when the lid closes.
sidebar:
  label: Laptop CI
---

Your laptop is idle most of the time you're coding, and it's usually faster than a 2-core hosted runner. This guide runs your CI there while you work, and on GitHub the rest of the time, with nothing to switch.

## 1. Connect the laptop

```sh
npx relayrunner connect
```

Sign up and install the GitHub App when it asks. Leave `connect` running in a terminal tab.

## 2. Route your jobs

In your repo's checkout:

```sh
npx relayrunner init
```

Pick the jobs to route. Each keeps its old label, such as `ubuntu-latest`, as the fallback. Commit and push.

## 3. Check the runner order

On the dashboard's **Router** page, a new workspace starts with:

1. Self-hosted
2. GitHub-hosted

That's what you want: the laptop when it's free, GitHub otherwise.

## What happens day to day

- **While you work**, jobs you push run on the laptop. The `connect` terminal shows each one.
- **When the laptop is busy** with as many jobs as it runs at once, the next one goes to GitHub, so a long test run never blocks a quick lint.
- **When the lid closes** or you stop `connect`, jobs go to GitHub, with nothing to change.
- **A job running at that moment** stops with the laptop. Re-run it and it goes to GitHub.

To keep the laptop free for a while, without going offline, press `p` in the `connect` terminal or run `relayrunner pause`.

## Keep it to your own jobs

A new machine only runs jobs you started, so a teammate's push or a bot never lands on your laptop. Leave it that way for a personal machine. See [Your machines](/docs/runners/self-hosted#who-can-run-jobs-on-it).

## Linux jobs on a Mac

Most Node, Python, Go or Rust jobs run fine on macOS. Jobs that install Linux packages with `apt`, or use `services:` or `container:`, need Linux or Docker. `init` warns about these. Give them `machine: Linux` instead, or leave them on GitHub.
