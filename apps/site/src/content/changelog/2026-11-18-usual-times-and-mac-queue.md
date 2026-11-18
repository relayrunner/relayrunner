---
title: Usual times, job history and the Mac queue
date: 2026-11-18
description: See how long each job usually takes and has left, list a machine's jobs with relayrunner history, and see what's waiting in RelayRunner for Mac.
---

- **Time left for running jobs.** The **Runners** page and the History run panel show about how long each running job has left, from how long it usually takes on that runner, and flag one that's slower than usual. See [Self-hosted runners](/docs/runners/self-hosted).
- **`relayrunner history`.** `connect` keeps a history of the jobs it runs, and `relayrunner history` lists them with each one's result and time. CLI 0.14.0. See [`history`](/docs/reference/cli#history).
- **RelayRunner for Mac 0.4.0.** The menu has Now, Queue and History tabs: a row per slot with each job's usual time and time left, the jobs waiting for this Mac by name, and the last 12 hours of jobs. When jobs go to another runner because every slot is busy, one click allows one more job at once. Pause new jobs for an hour, four hours or until tomorrow. It updates itself. See [RelayRunner for Mac](/docs/get-started/mac-app).
