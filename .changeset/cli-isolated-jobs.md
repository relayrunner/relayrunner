---
"relayrunner": minor
---

`relayrunner connect --isolated` (experimental) runs each job in its own Linux VM on a Mac with Apple silicon, using Apple's `container` tool. The VM starts from GitHub's runner image with none of your files mounted, can reach the internet but not your Mac or local network, and is deleted when the job ends. `--image` builds on another runner image.
