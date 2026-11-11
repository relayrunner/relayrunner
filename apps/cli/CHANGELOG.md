# relayrunner

## 0.5.0

### Minor Changes

- 0e7ab11: `relayrunner connect` now names its terminal tab after the machine and what it's doing, such as "RelayRunner · M3P0 · Waiting for jobs", "Running a job" or "Paused", and puts the old title back when it exits. Press `p` to pause or resume the machine without disconnecting, the same as pausing it on the Runners page.

### Patch Changes

- 83edb50: On a Mac without a hostname of its own, the suggested machine name is now the Computer Name from System Settings (such as "Zach's MacBook Pro") instead of a generic one like `Mac.local`. A hostname you set still comes first. The download message also says that `actions/runner` is GitHub's official runner.

## 0.4.0

### Minor Changes

- 90b736f: `relayrunner connect` gets a new machine token from the gateway each time it comes online and the old one stops working, so a copied `machine.json` can't sign in as the machine for long. If another copy does sign in while this one is online, the person who approved the machine gets an email.

  Before it runs a job, `connect` checks the job's runner config: only GitHub's files, only GitHub servers over https, and a runner named for that job. Anything else is refused and reported as a failed job. The terminal now shows which repo each job is from.

  `--server`, `RELAYRUNNER_URL` and saved sign-ins must use https, except for `localhost` while developing.

  The sharing prompt now says that "Anyone in the workspace" only covers jobs from repos you can open.
