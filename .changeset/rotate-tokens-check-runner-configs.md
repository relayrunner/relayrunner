---
"relayrunner": minor
---

`relayrunner connect` gets a new machine token from the gateway each time it comes online and the old one stops working, so a copied `machine.json` can't sign in as the machine for long. If another copy does sign in while this one is online, the person who approved the machine gets an email.

Before it runs a job, `connect` checks the job's runner config: only GitHub's files, only GitHub servers over https, and a runner named for that job. Anything else is refused and reported as a failed job. The terminal now shows which repo each job is from.

`--server`, `RELAYRUNNER_URL` and saved sign-ins must use https, except for `localhost` while developing.

The sharing prompt now says that "Anyone in the workspace" only covers jobs from repos you can open.
