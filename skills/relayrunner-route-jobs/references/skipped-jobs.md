# Skipped jobs

`relayrunner init` skips a job when routing it isn't safe or can't work. Offer a hand edit only when the user wants that job routed and the reason allows it.

## Can be routed, if the user says so

### Deploy jobs

**looks like a deploy job** (`environment`, `write-all permissions`, a secret other than `GITHUB_TOKEN`, or `id-token: write` used to sign in to a cloud or publish a package). Running it on a machine gives that machine the job's secrets and cloud access. That's the user's call: explain it, and route the job only if they say yes. Then let `init` write it: name the job in both `--apply` and `--allow-deploy`.

`id-token: write` on its own isn't a deploy. A job that only requests OIDC tokens, such as for a Turbo or Vercel remote cache, comes back ready with a warning.

### Label lists and runner groups

**runs-on is a list of labels**, such as `[self-hosted, m1, macmini]`, or **a runner group**. The relay answers with one label, so routing replaces the list or group with two things in the relay:

- `machine`: what kind of machine may take the job, such as `macOS, ARM64`. Any of the user's connected machines that matches can take it; RelayRunner machines don't have custom labels like `macmini`. For a specific Mac to take the job, run `relayrunner connect` on it.
- One hosted label for when no machine is free, such as `github: macos-latest`.

So route it by hand only when another matching machine, or that hosted label, can do the job. Leave it alone when the job needs that exact runner, such as one with attached hardware or a signing identity only it has. See [Routing a job by hand](#routing-a-job-by-hand) below.

## Can't be routed

- **uses a matrix**: one relay answers one job, so it can't serve every leg.
- **runs-on is an expression**: the relay needs one plain label to fall back to.
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
- Put the job's old `runs-on` label in `github`, or in the hosted provider's input if it was that provider's label (`depot: depot-ubuntu-24.04`). For a label list or runner group, use the hosted label you picked with the user.
- Use `machine: macOS` instead of `self-hosted` when the old label was a macOS one.
- If the job already has `needs:`, add the relay to the list: `needs: [build, relay-deploy]`.
- Keep everything else in the job, and give every routed job its own relay.

Run `relayrunner init --plan --json` again afterwards. The job should show `"verdict": "routed"`.
