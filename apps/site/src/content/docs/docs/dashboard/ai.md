---
title: AI
description: What AI does in RelayRunner, what it reads, and how to turn it on or off.
---

AI tells you why a job failed and what each job does. It's off until an owner or admin turns it on for the workspace.

## What it does

- **Failure causes**: History says why a failed job failed, such as a flaky test, a lint error or a broken runner.
- **Job types**: Performance sorts jobs by what they do: lint, tests, end-to-end tests, builds or deploys.
- **Smarter retries**: with [automatic retries](/docs/concepts/routing#automatic-retries) on, a job that failed on something flaky, like a timeout, gets retried too. A job that's sure to fail again isn't.

## What it reads

- Workflow, job and step names, and runner labels.
- For a failed job, the last 30 lines of its log and GitHub's error annotations. GitHub hides secrets in logs before we read them.

AI never reads your code.

## Where it goes

A decision model called Clef-flash answers. Cloudflare hosts it on Workers AI, the same platform the rest of RelayRunner runs on. Your data doesn't go to any other AI company.

- **Nothing is kept.** Cloudflare doesn't keep what we send once it answers, and we don't keep it either. We only save the answer, such as "flaky test".
- **Nothing trains models.** Cloudflare doesn't train on it, and neither do we.

## Turn it on or off

1. Open **Settings → AI**. Owners and admins can change it.
2. Check **Use AI in this workspace**.

Turning it off stops AI right away, and History and Performance go back to how they looked before.
