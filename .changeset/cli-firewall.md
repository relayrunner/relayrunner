---
"relayrunner": minor
---

`relayrunner firewall on` adds a firewall on your Mac for isolated jobs. Job VMs can reach the internet, not your Mac or your local network, and no job can remove it, even with Docker. It asks for your password, stays on after a restart, and `relayrunner firewall off` removes it.
