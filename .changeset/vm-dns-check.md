---
"relayrunner": patch
---

`relayrunner connect` now checks that its Linux VMs can look up hostnames before it builds the job image. When they can't, often because of VPN or DNS filtering software that's still running when its app is closed, it says so and how to check, instead of failing to build the image.
