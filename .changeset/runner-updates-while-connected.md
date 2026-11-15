---
"relayrunner": minor
---

`connect` now keeps GitHub's runner up to date while it stays open. Every 6 hours it checks for a newer release and switches to it between jobs, so a job that's running finishes on the runner it started with. Before, a machine left connected for weeks fell behind until GitHub stopped sending it jobs.
