# Skipped jobs

`relayrunner init` skips a job when routing it isn't safe or can't work. Offer a hand edit only when the user wants that job routed and the reason allows it.

## Can be routed by hand, if the user says so

**looks like a deploy job** (`environment`, `id-token: write`, `write-all permissions`, or a deploy secret). Running it on a machine gives that machine the job's secrets and cloud access. That's the user's call: explain it, and route the job only if they say yes.

## Can't be routed

- **uses a matrix**: one relay answers one job, so it can't serve every leg.
- **runs-on is an expression**, or **a list of labels or a runner group**: the relay needs one plain label to fall back to.
- **calls a reusable workflow**, or **part of a reusable workflow**: the reusable workflow picks its own runner.
- **has no runs-on**.

Say why and move on. If the user really wants a matrix job routed, they can split it into one job per leg, each with its own relay; only suggest that when the matrix is small.

## Leave alone

- **Windows jobs**: machines don't take Windows jobs yet.
- **already runs on a self-hosted runner**, or **already runs on RelayRunner**.
- **isn't a GitHub-hosted or hosted provider label**: RelayRunner doesn't know where to fall back to.

## Routing a job by hand

Write what `init` would: the relay job from step 3 of the skill, named `relay-<job id>`, just above the job, and the job's `needs` and `runs-on` pointing at it.

- Use `relayrunner/actions/.github/workflows/relay.yml@<relay>`, with `<relay>` from `relayrunner init --plan --json`.
- Put the job's old `runs-on` label in `github`, or in the hosted provider's input if it was that provider's label (`depot: depot-ubuntu-24.04`).
- Use `machine: macOS` instead of `self-hosted` when the old label was a macOS one.
- If the job already has `needs:`, add the relay to the list: `needs: [build, relay-deploy]`.
- Keep everything else in the job, and give every routed job its own relay.

Run `relayrunner init --plan --json` again afterwards. The job should show `"verdict": "routed"`.
