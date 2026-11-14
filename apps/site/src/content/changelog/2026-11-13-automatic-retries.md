---
title: Automatic retries
date: 2026-11-13
---

The Router can now re-run a job that failed because of its runner, not its own steps: its runner never started it, its machine went offline, or GitHub lost touch with it. The retry routes again, so it can land on a different runner.

Turn it on with **Retry jobs when their runner fails** on the Router page, or per repo with [`retry`](/docs/reference/repo-config#retry). See [Automatic retries](/docs/concepts/routing#automatic-retries).
