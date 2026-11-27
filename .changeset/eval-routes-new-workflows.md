---
"relayrunner": minor
---

`relayrunner eval` works in a brand-new account. In a clone, it lists the workflow files in `.github/workflows` along with the ones that ran, and if the workflow you pick isn't routed yet, it offers to route it with the same picker as `relayrunner init`, adding `workflow_dispatch` in the same edit. After a yes, it pushes the change to a `relayrunner/route-<workflow>` branch and prints the link to open a pull request; it never pushes to the default branch. The evaluation then starts and waits for the pull request to be merged, and while you watch, it tries again every 30 seconds.
