# Set up RelayRunner with an agent

You are a coding agent setting up RelayRunner for the user. RelayRunner runs a private repo's
GitHub Actions jobs on the user's own computer when it is online and free. Otherwise the jobs
run on their usual runners. Setup has three parts: sign this computer in, route the repo's jobs
through RelayRunner, then put the computer online.

The `relayrunner` CLI does the work. It decides which jobs can be routed and writes the workflow
changes, so don't write the relay YAML from memory. You run the CLI, explain what it found, and
only hand-edit a job when the CLI skipped it and the user asks you to.

Work in the user's current checkout unless they name another. Explain each step in a sentence
before you run it. Ask before changing any file.

## 1. Check the basics

- Supported systems are macOS and Linux, on x64 or ARM64. Windows is not supported yet. Stop
  and say so if the computer runs anything else.
- Node.js 22 or newer: `node --version`.

Install the CLI and check it has the commands this guide uses:

```sh
npm install --global relayrunner@latest
relayrunner --help
```

The help should list `login`, `connect`, `whoami` and `init`. If the user prefers not to install
globally, use `npx relayrunner@latest` in place of `relayrunner` in every command below.

## 2. Sign this computer in

```sh
relayrunner whoami --json
```

- `status` `"ok"`: the computer is already enrolled. Tell the user which machine and workspace
  it is (`machine.name`, `workspace.name`). Go to step 3.
- `status` `"signed_out"` or `"revoked"`: run `relayrunner login`.
- `status` `"unverified"`: the gateway couldn't be reached. Say so and try again before going on.

```sh
relayrunner login
```

`login` prints a URL and a code, opens the browser, and waits until the user approves (up to 30
minutes). Tell the user the URL and the code before you wait. In the browser they sign in with
GitHub (this creates their account), create or pick a workspace, install the RelayRunner GitHub
App on their organization or personal account, check that the code matches, and approve this
computer. `login` then saves the machine's token and exits. It does not put the computer online.

A new machine only runs jobs the user started. If the workspace has other members, `login`
says so. Then ask the user whether teammates' jobs may run here too, and if they say yes, run
`relayrunner share anyone` (`relayrunner share only-me` undoes it, and `relayrunner share`
shows the current setting). If the user already told you, pass `--share only-me` or
`--share anyone` to `login`. Leave it to the user: don't change it yourself unless they ask.

Run `relayrunner whoami --json` again and expect `status` `"ok"`. If the GitHub App install only
sent a request to the org's owners, jobs start reaching this computer once an owner accepts it.

## 3. See which jobs can be routed

```sh
relayrunner init --plan --json
```

This changes nothing. The result looks like:

```json
{
  "repo": "acme/api",
  "visibility": "private",
  "relay": "v1.0.0-beta.4",
  "setUp": false,
  "jobs": [
    {
      "file": ".github/workflows/ci.yml",
      "job": "test",
      "verdict": "ready",
      "provider": "github",
      "label": "ubuntu-latest",
      "machine": "self-hosted",
      "warnings": []
    },
    { "file": ".github/workflows/ci.yml", "job": "lint", "verdict": "routed", "warnings": [] },
    {
      "file": ".github/workflows/deploy.yml",
      "job": "deploy",
      "verdict": "skipped",
      "reason": "looks like a deploy job (environment)",
      "warnings": []
    }
  ],
  "errors": []
}
```

- If it has `"refused": "public_repo"`, stop. RelayRunner never sends a public repo's jobs to a
  personal computer, so there is nothing to set up here. Tell the user.
- If `visibility` is `"unknown"`, the CLI couldn't check. Ask the user, or check with
  `gh repo view --json visibility` if the GitHub CLI is available. Only private repos route.
- If it prints `{ "error": ... }`, tell the user what it says. The usual one is that the folder
  isn't a git checkout.

Go over the jobs with the user, grouped by `verdict`, in plain words:

- **ready**: can be routed. Say where it runs when this computer is offline or busy: `label` on
  `provider` (GitHub-hosted or Blacksmith). A `macos-*` job only goes to macOS machines
  (`machine` is `macOS`). Read out each `warnings` entry. They are things to check, such as a job
  that installs Linux packages while this computer is a Mac, or one that needs Docker.
- **routed**: already goes through RelayRunner. Nothing to do.
- **skipped**: left alone, with the `reason`. Step 5 covers what can still be done by hand.

Also mention anything in `errors`: a workflow file the CLI couldn't parse.

Let the user pick which ready jobs to route. Suggesting all of them is fine, minus any whose
warnings the user doesn't want to deal with.

## 4. Route the chosen jobs

```sh
relayrunner init --apply test,lint --json
```

Name jobs by their id (`test`), or as `file:id` (`ci.yml:test`) when the same id is in more than
one workflow. `all` routes every ready job. The CLI edits the files in `.github/workflows/`,
keeps comments and formatting, and never commits. It refuses a job that isn't ready and says
why.

## 5. Skipped jobs (only if the user wants)

Offer a hand edit only when the user wants a skipped job routed and the reason allows it:

- **looks like a deploy job**: the job has an `environment`, `id-token: write`, or uses secrets.
  Running it on the user's computer gives that computer those secrets, so it's their call. Only
  route it if they say so.
- **uses a matrix**, **runs-on is an expression**, **runs-on is a list of labels or a runner
  group**, **calls a reusable workflow**, **part of a reusable workflow**: these can't be routed,
  even by hand. One relay can't serve several matrix legs, and a reusable workflow decides its own
  runner. Say so and move on.
- **Windows**, **already runs on a self-hosted runner**, **isn't a GitHub-hosted or Blacksmith
  label**: leave these alone.

For a job the user does want routed, copy what `init` writes. Add a relay job just above it,
named `relay-<job id>`, and point the job at the relay's answer:

```yaml
jobs:
  relay-deploy:
    uses: relayrunner/actions/.github/workflows/relay.yml@<relay>
    with:
      machine: self-hosted
      github: ubuntu-latest

  deploy:
    needs: relay-deploy
    runs-on: ${{ needs.relay-deploy.outputs.runner }}
    environment: production
    steps: ...
```

- Replace `<relay>` with the `relay` value from `init --plan --json`, such as `v1.0.0-beta.4`.
  Keep the rest of the `uses:` line exactly as shown.
- Put the job's old `runs-on` label in `github`, or in `blacksmith` if it starts with
  `blacksmith-`. Use `machine: macOS` instead of `self-hosted` if the old label starts with
  `macos-`.
- If the job already has `needs:`, add the relay to the list (`needs: [build, relay-deploy]`).
  Keep everything else in the job as it is.

## 6. Show the diff

```sh
git diff
```

Show it to the user and say what each change does. The user commits and pushes. Don't commit or
push for them unless they ask. The change takes effect on the next run, and the checks keep
their names in GitHub.

## 7. Put this computer online

`relayrunner connect` is the on/off switch. While it runs, the computer is online and takes jobs.
When it stops, jobs go back to their usual runners, with no workflow change. Ask the user how
they want to run it:

- **In their own terminal (recommended).** They run `relayrunner connect` and leave it open. It
  keeps running after this session ends. Ctrl-C takes the computer offline.
- **Started by you, for now.** Run `relayrunner connect` in the background. It's handy for
  checking the first run, but it stops when your session ends, and the computer goes offline.
  Tell the user that, and that they can run it themselves later.

If `connect` asks whether to set up the repo, it means nothing is routed yet. Answer no, since
you did that in step 4 (or nothing was picked).

## 8. Confirm it works

After the user pushes and `connect` is running, a run of a routed job shows `relay-<job> /
RelayRunner` finishing in about a second, then the job itself. In the job's log, the runner name
tells where it ran: a name starting with this computer's machine name (from `relayrunner whoami`)
means it ran here, and a GitHub-hosted name means the fallback label. If
`relay-<job> / RelayRunner` stays queued, the GitHub App is probably not installed on the repo's
owner, or doesn't cover this repo. The user can check under Settings → GitHub accounts in the
dashboard.

To take this computer out of the rotation for a while, the user stops `relayrunner connect`, or
runs `relayrunner pause` to stay connected but take no new jobs (`relayrunner resume` undoes it).

## If the CLI can't be used

Only if `relayrunner init` isn't available (an old CLI that can't be upgraded), write the same
change by hand for each ready job, as in step 5, using relay version `v1.0.0-beta.4`. Use the
same rules: no matrix, a plain GitHub-hosted (`ubuntu-*`, `macos-*`) or Blacksmith
(`blacksmith-*`) `runs-on`, and no deploy jobs unless the user says so. Blacksmith also needs to
be in the workspace's runner order on the dashboard's Runners page.
