---
"relayrunner": minor
---

`relayrunner eval` works in a brand-new account. In a clone, it lists the workflow files in `.github/workflows` along with the ones that ran, and if the workflow you pick isn't routed yet, it offers to route it with the same picker as `relayrunner init`, adding `workflow_dispatch` in the same edit. After a yes, it commits and pushes the change to the default branch, or to a `relayrunner/route-<workflow>` branch with a pull request link when it can't. The evaluation then starts and waits for the change to reach the default branch, and while you watch, it tries again every 30 seconds.
