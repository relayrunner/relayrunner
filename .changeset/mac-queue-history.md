---
"relayrunner": patch
"@relayrunner/mac": minor
---

The Mac menu has Now, Queue and History tabs. Queue lists the jobs waiting for this Mac and how long each has waited, and says when jobs went to hosted runners in the last hour because every slot was busy. History shows the last 12 hours as a bar per hour, with the latest jobs, all or only failed. `connect --events` adds `queue` and `spilled` to `waiting` and `state`.
