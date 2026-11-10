# Set up RelayRunner with an agent

You are a coding agent setting up RelayRunner for the user. RelayRunner runs a private repo's
GitHub Actions jobs on the user's own computer when it is online and free. Otherwise the jobs
run on GitHub-hosted runners as usual. Setup has two parts: connect this computer, then opt
jobs in with a small workflow change.

Work in the user's current checkout unless they name another. Explain each step in a sentence
before you run it. Ask before changing any file.

## 1. Check the basics

- Supported systems are macOS and Linux, on x64 or ARM64. Windows is not supported yet. Stop
  and say so if the computer runs anything else.
- Node.js 22 or newer: `node --version`.
- The checkout's GitHub repo must be **private**. RelayRunner never routes public repos to a
  personal computer. It can be owned by a GitHub organization or a personal account. Check with
  `gh repo view --json visibility,owner` if the GitHub CLI is available, or ask the user.

## 2. Install the CLI

```sh
npm install --global relayrunner@latest
relayrunner --help
```

If the user prefers not to install globally, use `npx relayrunner@latest` in place of
`relayrunner` in every command below.

## 3. Connect this computer

Check whether it is already connected:

```sh
relayrunner whoami --json
```

- If `status` is `"ok"`, the computer is enrolled. Tell the user which machine and workspace
  it is, and whether `machine.status.online` is true. Then go to step 4.
- Otherwise it needs to sign in.

`relayrunner connect` signs in on the first run, then stays running in the foreground. While
it runs, the computer is online and takes jobs. When it stops, jobs go back to GitHub. Ask the
user to run it **in their own terminal and leave it open**:

```sh
relayrunner connect
```

Don't run it yourself unless the user asks: it would go offline when your session ends.

The first run opens the browser to the RelayRunner dashboard. There the user signs in with
GitHub (this creates their account), creates a workspace, installs the RelayRunner GitHub App
on their organization or personal account, and approves the computer. The terminal then says
the machine is enrolled and online.

If the workspace has other members, `connect` asks who can run jobs on this computer: only
jobs the user started (`only-me`, the default) or any job in the workspace (`anyone`). To set
it without the question, add `--share only-me` or `--share anyone`. The user can change it
later with `relayrunner share only-me` or `relayrunner share anyone`, and
`relayrunner share` shows the current setting. Leave it to the user: don't change it
yourself unless they ask.

When the user says it's done, check again with `relayrunner whoami --json`. Expect `status`
`"ok"` and `machine.status.online` true. If the GitHub App install only sent a request to the
org's owners, jobs start reaching this computer once an owner accepts it.

## 4. Choose the jobs

List the workflows in `.github/workflows/` and the jobs in each. Suggest jobs that can run on
this computer, and let the user pick. A job is a good fit when:

- it runs on a GitHub-hosted label today, such as `ubuntu-latest`, or on a Blacksmith label,
  such as `blacksmith-2vcpu-ubuntu-2404`. When the computer is offline or busy, an opted-in job
  runs on that label, which you pass to the relay's `github` or `blacksmith` input (see step 5).
- it has **no** `strategy.matrix`. Each routed job needs its own relay, so a matrix can't share
  one.
- it has no `container:` or `services:`, unless this computer is Linux with Docker running.
- its steps work on this computer's OS. On macOS, check for Linux-only commands such as
  `apt-get`, and for actions that only support Linux.
- it doesn't deploy or use production secrets. It is the user's computer, so that is their
  call, but point it out.

## 5. Show the patch, then apply it

For each chosen job, add a relay job just before it. The relay is RelayRunner's reusable
workflow, [`relayrunner/actions`](https://github.com/relayrunner/actions). It asks RelayRunner
where this run of the job should go. Then point the job's `runs-on` at the relay's answer.
Name the relay `relay-<job id>` so each routed job has its own.

Before:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

After:

```yaml
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1.0.0-beta.2
    with:
      machine: self-hosted
      github: ubuntu-latest

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
    steps:
      - uses: actions/checkout@v4
      - run: npm test
```

Use the `uses:` line exactly as shown. GitHub needs the full path to a reusable workflow, and
the tag pins the version. The relay's inputs say which runners can take the job:

- `machine` lists labels a machine must have, comma-separated, and a machine needs all of them.
  `self-hosted` means any of the user's machines. To keep a job on matching machines only, name
  the OS or architecture, such as `machine: macOS, ARM64`. Without `machine`, the job never runs
  on the user's machines.
- `github` is the GitHub-hosted label to use when no machine fits. Put the job's old
  `runs-on` label here, such as `ubuntu-24.04` or `macos-latest`.
- `blacksmith` is the Blacksmith label to use, such as `blacksmith-2vcpu-ubuntu-2404`. If the
  job's old `runs-on` starts with `blacksmith-`, put it here instead of in `github`. Blacksmith
  must also be in the workspace's runner order on the dashboard's Runners page; the user decides
  where it goes. Blacksmith needs relay `v1.0.0-beta.4` or later.

If no runner fits, the relay fails with the reason, and the job doesn't start.

Keep everything else in the job as it is. Watch out for these cases:

- **The job already has `needs:`.** Add the relay to the list (`needs: [build, relay-test]`).
- **The job already has `if:`.** Keep it as it is.
- **Other jobs depend on this one.** Leave them alone. They still depend on `test`.

Show the user the full diff and wait for their approval before you write it. Then tell them
to commit and push it. It takes effect on the next run, and the checks keep their names in
GitHub.

## 6. Confirm it works

After the user pushes, a run of an opted-in job shows `relay-<job> / RelayRunner` finishing in
about a second, then the job itself. In the job's log, the runner name tells where it ran: a name starting
with this computer's machine name (from `relayrunner whoami`) means it ran here, and a
GitHub-hosted name means the `github` label. If `relay-<job> / RelayRunner` stays
queued, the GitHub App is probably not installed on the repo's owner.
The user can check under Settings → GitHub accounts in the dashboard.

To stop using this computer for a while, the user presses Ctrl-C in the `relayrunner connect`
terminal. Jobs go back to GitHub-hosted runners, with no workflow change.
