---
"relayrunner": minor
---

A machine is now in every workspace you're a member of, so signing in no longer means picking one. `relayrunner connect` and `login` print the workspaces the machine is in, and `whoami` lists them. The sharing question shows when any of your workspaces has someone else in it, and `anyone` means any job in your workspaces. If you aren't in a workspace yet, signing in still works: the CLI says so and links to the GitHub install, and the machine takes jobs once you're in one. `~/.relayrunner/machine.json` no longer saves a workspace, and files from earlier versions still load.
