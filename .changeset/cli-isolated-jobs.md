---
"relayrunner": minor
---

`relayrunner connect --isolated` (experimental) runs each job in its own Linux VM on a Mac with Apple silicon, using Apple's `container` tool. The VM starts from GitHub's runner image with none of your files mounted, can reach the internet but not your Mac or local network, and is deleted when the job ends. `--local-network` lets jobs reach your network, and `--image` starts from another runner image. `connect` removes the images it got for older runner versions, and keeps a log of what it did in `~/.relayrunner/isolated.log`.
