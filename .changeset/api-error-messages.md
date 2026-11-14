---
"relayrunner": patch
---

When the gateway refuses a request, `pause`, `share`, `whoami` and `workspaces` now show its reason and error code, such as "Only a machine with an owner can do this (MACHINE_NOT_OWNED)", instead of only the HTTP status.
