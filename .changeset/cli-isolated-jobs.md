---
"relayrunner": minor
---

`relayrunner connect --isolated` (experimental) runs each job in its own Linux VM on a Mac with Apple silicon, using Apple's `container` tool. The VM starts from GitHub's runner image with none of your files mounted and is deleted when the job ends. `--image` picks another runner image.
