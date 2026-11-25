---
title: Jobs that can't route say why on the pull request
date: 2026-11-23
type: Feature
description: A failed RelayRunner check names the reason a job couldn't route, starting with the one you can fix.
---

- **A check on the pull request.** When no runner in your order can take a job, a failed **RelayRunner: couldn't route** check names the reason in the pull request's checks list. It turns green once a re-run routes.
- **The fixable reason first.** The message leads with what you can change, such as a limit that was reached, then says why each other provider couldn't take the job. The job's log and the run's summary page show the same message, with a link to the dashboard page that fixes it. See [Troubleshooting](/docs/reference/troubleshooting).
