---
"relayrunner": minor
---

`relayrunner connect` runs several jobs at once: 2 on a computer with 8 or more CPU cores, otherwise 1. `--concurrency <n>` changes it. Each slot runs its jobs in its own copy of the runner (`~/.relayrunner/runner/<version>/slot-<n>/`), and with more than one slot each line of a job's output starts with its slot.
