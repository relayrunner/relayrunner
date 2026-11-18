---
"relayrunner": minor
"@relayrunner/mac": minor
---

RelayRunner for Mac has a Jobs window (Jobs… in the menu, ⌘J while it's open). It lists every job the Mac ran in the last week, sortable by how long each waited and ran. Pick one to see its steps on a timeline and, for a failed job, the step that failed, GitHub's annotations, the end of its log and, when the workspace has AI on, the likely cause. The CLI gains `relayrunner jobs` and `relayrunner jobs <id>`, which read the same from the gateway with the machine's own token.
