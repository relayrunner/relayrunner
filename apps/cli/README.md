# RelayRunner CLI

Connects a machine to the RelayRunner gateway so it can run GitHub Actions jobs
in your workspaces. It's published to npm as
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
name this machine and approve. The machine is yours, and it's in every workspace
you're a member of (one per GitHub account or org RelayRunner is installed on),
so there's no workspace to pick. `connect` prints which ones it's in. If you
aren't in one yet, say because you skipped the install or an org owner hasn't
accepted your install request, it says so and links to the install. The
machine can still go online, and it takes jobs once you're in a workspace. The machine token is
saved to `~/.relayrunner/machine.json` (mode 0600); later runs reuse it. The
gateway sends a new token every time `connect` comes online and the old one
stops working, so a copy of `machine.json` from a backup or a synced dotfiles
folder can't sign in as the machine.

While it runs, the machine is online: it keeps a WebSocket open to the gateway,
runs the jobs it's sent and prints what happens, including the
repo each job is from. It reconnects on its own if the connection drops. Ctrl-C
takes it offline; a job that's running stops with it. Press `p` to pause or
resume it without going offline (see `relayrunner pause`). The terminal tab's
title shows the machine and what it's doing, such as
`RelayRunner · M3P0 · Waiting for jobs`.

Before it starts a job, `connect` checks the job's runner config: it must hold
only the files GitHub's do, every server in it must be GitHub's, over https, and
the runner must be named for that job. Anything else is refused and reported as
a failed job, so a gateway that was tampered with can't point the runner at a
server of its own or write files outside the runner. It can't tell a job the
gateway routed here from a runner it minted on a GitHub repo of its own, so the
terminal shows which repo each job is from.

If another `connect` signs in as this machine while it's online, this one stops
and says so. When that happens from a different network, the person who
approved the machine also gets an email, since someone else may have its token.

- `--server <url>` or `RELAYRUNNER_URL` points it at another gateway. Changing it signs in again.
  It must be https, except for `localhost` while developing, since the token goes
  out on every connect.
- `--name <name>` changes the suggested machine name (default: the hostname if
  one is set, otherwise the Mac's Computer Name from System Settings).
- `--share only-me|anyone` sets who can run jobs on this machine without asking.
  It works on a machine that's already signed in too.
- `--concurrency <n>` sets how many jobs it runs at once. The default is 2 on a
  computer with 8 or more CPU cores, otherwise 1, and `connect` prints it. Each
  slot runs its jobs in its own copy of the runner,
  `~/.relayrunner/runner/<version>/slot-<n>/`, made when `connect` starts (a
  copy-on-write clone where the disk supports it). With more than one slot,
  each line of a job's output starts with its slot, such as `[slot 2]`.
- `--isolated` (experimental) runs each job in its own Linux VM, so a job can't
  read your files or the machine token. It needs a Mac with Apple silicon,
  macOS 26 and Apple's [container](https://github.com/apple/container/releases)
  tool, started with `container system start`. Each VM starts from GitHub's
  runner image with nothing mounted and is deleted when the job ends. Jobs run
  on Linux arm64, and Docker isn't available in them yet.
  - A firewall in the VM lets the job reach the internet but not your Mac or
    your local network. `connect` builds the job image for it once per runner
    version. `--local-network` turns the firewall off, for jobs that need
    something on your network, and skips that build.
  - `--image <image>` starts from another runner image.
  - `connect` removes the images it downloaded or built for older runner
    versions. It never removes images you got yourself.
  - `~/.relayrunner/isolated.log` records each `container` command and its
    result, never a job's output or credentials. Send it along when you report
    a problem.
- If the machine is removed in the dashboard, `connect` deletes the saved token.
  A running `connect` exits and asks you to run it again; a new one signs in
  straight away.

A new machine runs only jobs you started (`only-me`). Right after signing in,
if any of your workspaces has other members, `connect` asks "Who can run jobs on
this machine?": Only me, or Anyone in your workspaces (teammates' and bots' jobs
too). It doesn't ask when you're alone in all of them, on later runs, or without
a terminal to answer. [`relayrunner share`](#relayrunner-share) changes it later.

When you approve the machine in the browser, you pick which of your workspaces it
runs jobs in. `connect` then prints them with `Change with: relayrunner workspaces`
([`relayrunner workspaces`](#relayrunner-workspaces)).

Run inside a checkout of a private repo where no job uses RelayRunner yet,
`connect` first asks whether to set it up (default no). Yes runs the same picker
as [`relayrunner init`](#relayrunner-init). No is remembered for that repo in
`~/.relayrunner/declined-repos.json`, so it doesn't ask again; `init` still
works there. It never asks outside a repo, in a public repo, in a repo that's
already set up, or without a terminal to answer.

Jobs run in `actions/runner`, GitHub's official self-hosted runner, which is downloaded into
`~/.relayrunner/runner/<version>` on first connect and checked against its
SHA-256. Set `RELAYRUNNER_HOME` to keep everything somewhere else.

## `relayrunner login`

```sh
npx relayrunner login
```

Signs this machine in without putting it online: the same browser sign-in as the
first `connect`, then it saves the token and exits. It's for a coding agent
setting up RelayRunner (see [docs/agent-install.md](../../docs/agent-install.md)),
which can't keep `connect` running after its session ends. Run `connect`
afterwards to take jobs.

If the machine is already signed in to that gateway, it says so and exits. A
token that's no longer valid is replaced. `--server`, `--name` and `--share` work as they do
for `connect`.

## `relayrunner whoami`

```sh
npx relayrunner whoami
```

Asks the gateway who the saved machine token belongs to and prints the machine,
the workspaces it's in, who enrolled it (name and email) and whether it's online now.

- Not signed in: says so and exits 1.
- Removed (or the token is no longer valid): says so and
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
again. You can do the same from the machine's ⋯ menu on the
Runners page, and a running `relayrunner connect` prints when that happens.
In the terminal running `relayrunner connect`, `p` does the same.
Both exit 1 when not signed in or when the token is no longer valid.

## `relayrunner share`

```sh
npx relayrunner share            # show the current setting
npx relayrunner share only-me    # run only jobs you started
npx relayrunner share anyone     # run any job in your workspaces
```

Who can run jobs on this machine. `only-me` takes only jobs you started on
GitHub; `anyone` takes any job in your workspaces, including teammates' and
bots'. It's one setting for all of them.
It's the same setting as the sharing icon on the machine's card on the Runners
page, and only the machine's owner can change it there. `relayrunner whoami`
shows it too. Exits 1 when not signed in or when the token is no longer valid.

## `relayrunner workspaces`

```sh
npx relayrunner workspaces                # list the ones it's in and the ones it isn't
npx relayrunner workspaces add acme       # run jobs from Acme here too
npx relayrunner workspaces remove acme    # stop running Acme's jobs here
```

Which of your workspaces this machine runs jobs in, the same choice as the
"Run jobs in" checkboxes when you approve it. `list` (the default) shows the
workspaces it's in, the ones it isn't, and its sharing; `--json` prints the same
as JSON. `add` and `remove` take a workspace's name or slug in any case, or its
id when two have the same name. Leave the name out in a terminal to pick from a
list.

Adding a workspace while the machine is set to `anyone` warns that anyone who can
push to that workspace's private repos can run jobs on it. Removing the last one
leaves the machine connected but taking no jobs until you add one back. Exits 1
when not signed in, when the token is no longer valid, or when no workspace has
that name.

## Building

`pnpm --filter relayrunner build` bundles the CLI into `dist/cli.js` with
tsdown, including the workspace's `@relayrunner/machine-protocol` package.
Releases go out through changesets; see [.changeset/README.md](../../.changeset/README.md).
