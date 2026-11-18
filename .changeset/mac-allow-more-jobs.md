---
"relayrunner": patch
"@relayrunner/mac": minor
---

The Mac menu's Queue names each waiting job and its workflow once GitHub has said which job it is. When jobs went to hosted runners because every slot was busy, a button allows one more job at once: the app pauses new jobs, waits for the running ones to finish, and comes back with the extra slot, or goes back to the earlier setting if it can't.
