---
"relayrunner": minor
---

`relayrunner workspaces` shows which of your workspaces this machine runs jobs in and which it doesn't, with its sharing. `relayrunner workspaces add <name>` and `remove <name>` change that, by workspace name, slug or id, or from a list when you leave the name out. Adding a workspace while the machine runs anyone's jobs warns that anyone who can push to that workspace's private repos can run jobs on it. After you approve a new machine, `connect` prints the workspaces it runs jobs in and how to change them, and `connect` and `whoami` tell a machine that isn't in any of your workspaces apart from an account with no workspace yet.
