---
title: Jobs wait for a busy machine
date: 2026-11-13
---

When every machine that fits a job is busy and nothing later in your runner order can take it, the job now waits for a free slot instead of failing. Jobs get slots in the order they started waiting.

To send jobs elsewhere instead, add a step after your machines, such as `github` or a hosted provider. See [When every machine is busy](/docs/concepts/routing#when-every-machine-is-busy).
