---
"relayrunner": minor
---

On a Mac with Apple silicon and Apple's container tool, `connect` now runs each job in its own Linux VM, away from your files. `--macos` also takes macOS jobs on the Mac itself, and `--no-isolated` runs every job there. Without the container tool, jobs run on the Mac and `connect` says how to set it up.

New `--cpus` and `--memory` flags set the size of each job's VM, like a hosted runner's size. With a size and no `--concurrency`, as many jobs run at once as fit.
