# RelayRunner CLI

Connects a machine to the RelayRunner gateway so it can run your workspace's
GitHub Actions jobs. It's published to npm as
[`relayrunner`](https://www.npmjs.com/package/relayrunner) and needs Node.js 22
or newer on macOS or Linux (x64 or ARM64).

```sh
npm install --global relayrunner   # or use npx relayrunner
```

Machines only take jobs from private repositories. To opt jobs in, see the
[root README](../../README.md#how-it-works) or
[docs/agent-install.md](../../docs/agent-install.md).

## `relayrunner connect`

```sh
npx relayrunner connect
```

The first run signs you in: it shows a code and opens the dashboard, where you
pick the workspace and name for this machine and approve. The machine token is
saved to `~/.relayrunner/machine.json` (mode 0600); later runs reuse it.

While it runs, the machine is online: it keeps a WebSocket open to the gateway,
runs the jobs it's sent (one at a time) and prints what happens. It reconnects
on its own if the connection drops. Ctrl-C takes it offline; a job that's
running stops with it.

- `--server <url>` or `RELAYRUNNER_URL` points it at another gateway. Changing it signs in again.
- `--name <name>` changes the suggested machine name (default: the hostname).
- `--share only-me|anyone` sets who can run jobs on this machine without asking.
  It works on a machine that's already signed in too.
- If the machine is removed in the dashboard, `connect` deletes the saved token.
  A running `connect` exits and asks you to run it again; a new one signs in
  straight away.

A new machine runs only jobs you started (`only-me`). Right after signing in,
if the workspace has other members, `connect` asks "Who can run jobs on this
machine?": Only me, or Anyone in the workspace (teammates' and bots' jobs too).
It doesn't ask in a workspace of one, on later runs, or without a terminal to
answer. [`relayrunner share`](#relayrunner-share) changes it later.

Run inside a checkout of a private repo where no job uses RelayRunner yet,
`connect` first asks whether to set it up (default no). Yes runs the same picker
as [`relayrunner init`](#relayrunner-init). No is remembered for that repo in
`~/.relayrunner/declined-repos.json`, so it doesn't ask again; `init` still
works there. It never asks outside a repo, in a public repo, in a repo that's
already set up, or without a terminal to answer.

Jobs run in `actions/runner`, which is downloaded into
`~/.relayrunner/runner/<version>` on first connect and checked against its
SHA-256. Set `RELAYRUNNER_HOME` to keep everything somewhere else.

## `relayrunner whoami`

```sh
npx relayrunner whoami
```

Asks the gateway who the saved machine token belongs to and prints the machine,
its workspace, who enrolled it (name and email) and whether it's online now.

- Not signed in: says so and exits 1.
- Removed from the workspace (or the token is no longer valid): says so and
  exits 1. The saved token is left alone; the next `connect` replaces it.
- Gateway unreachable: prints what's saved locally, marked unverified, and exits 0.
- `--json` prints the same as JSON (never the token). `--server <url>` or
  `RELAYRUNNER_URL` only reports a sign-in for that gateway.

## `relayrunner init`

```sh
npx relayrunner init
```

Run inside a checkout, it routes the repo's GitHub Actions jobs through
RelayRunner: each chosen job gets a `relay-<job>` job in front of it (the
reusable workflow in [relayrunner/actions](https://github.com/relayrunner/actions)),
and its `runs-on` becomes the relay's answer. The job's old label becomes the
fallback when no machine is free. It only edits `.github/workflows/`, keeps
comments and formatting, and never commits.

It sorts every job into one of three groups:

- **Ready**: a plain GitHub-hosted (`ubuntu-*`, `macos-*`) or Blacksmith
  (`blacksmith-*`) label. A `macos-*` job only routes to macOS machines.
  Warnings flag what to check first: services or containers (need Docker),
  Linux package installs on a Mac, Blacksmith-only actions.
- **Already routed**: the job runs where a relay sends it.
- **Skipped, with the reason**: a matrix, a `runs-on` expression, list or
  group, a reusable workflow, a deploy job (`environment`, `id-token: write`,
  or secrets other than `GITHUB_TOKEN`), Windows, or an unknown label.

A public repo is refused: machines never take public repos' jobs. Visibility is
checked with an anonymous GitHub API call, so it doesn't matter which account
`gh` or git is signed in as.

- `--plan` lists the jobs and changes nothing; `--plan --json` prints them as JSON.
- `--apply <jobs>` routes jobs without prompting. Name them by id (`test`),
  `file:id` (`ci.yml:test`) when an id is in several workflows, or `all` for
  every ready job. Add `--json` for a JSON result.

## `relayrunner pause` and `relayrunner resume`

```sh
npx relayrunner pause
npx relayrunner resume
```

Pausing stops new jobs routing to this machine while it stays connected and
enrolled. A job it's already running finishes. `resume` lets jobs route here
again. Anyone in the workspace can do the same from the machine's ⋯ menu on the
Runners page, and a running `relayrunner connect` prints when that happens.
Both exit 1 when not signed in or when the token is no longer valid.

## `relayrunner share`

```sh
npx relayrunner share            # show the current setting
npx relayrunner share only-me    # run only jobs you started
npx relayrunner share anyone     # run any job in the workspace
```

Who can run jobs on this machine. `only-me` takes only jobs you started on
GitHub; `anyone` takes any job in the workspace, including teammates' and bots'.
It's the same setting as the sharing icon on the machine's card on the Runners
page, and only the machine's owner can change it there. `relayrunner whoami`
shows it too. Exits 1 when not signed in or when the token is no longer valid.

## Building

`pnpm --filter relayrunner build` bundles the CLI into `dist/cli.js` with
tsdown, including the workspace's `@relayrunner/machine-protocol` package.
