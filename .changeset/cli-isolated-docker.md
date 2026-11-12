---
"relayrunner": minor
---

Docker works in isolated jobs. `relayrunner connect --isolated` now starts Docker inside each job's VM, so jobs with `services:`, `container:` or `docker build` run. `--local-network` uses the same job image as the default, so it builds that image once too.
