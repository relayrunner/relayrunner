---
title: CLI
description: Every relayrunner command and flag.
---

The `relayrunner` CLI runs on macOS and Linux with Node.js 22 or newer. Run it with `npx relayrunner <command>`, or install it with `npm install --global relayrunner`. See [Install](/docs/get-started/install). On a Mac, [RelayRunner for Mac](/docs/get-started/mac-app) runs `connect` for you from the menu bar.

## `connect`

```sh
relayrunner connect
```

Puts this machine online and runs the jobs it's sent until you stop it. On a Mac with Apple silicon and Apple's container tool, each job runs in its own Linux VM; elsewhere jobs run on the machine itself. It runs up to 2 jobs at once on a computer with 8 or more CPU cores, otherwise 1; `--concurrency` changes that. The first run signs the machine in. Ctrl-C takes it offline, and a job that's running stops with it. Press `p` to pause or resume. While it stays open, it checks for a newer GitHub runner every few hours and switches to it between jobs.

Run inside a repo with no routed jobs, it offers to route them, the same as `init`.

| Flag                      | What it does                                                                 |
| ------------------------- | ---------------------------------------------------------------------------- |
| `--name <name>`           | The machine's name. Defaults to the computer's name.                         |
| `--share only-me\|anyone` | Who can run jobs on this machine.                                            |
| `--concurrency <n>`       | How many jobs to run at once. Defaults to 2 with 8+ CPU cores, else 1.       |
| `--macos`                 | Also take macOS jobs, which run on the Mac itself. Linux jobs stay in VMs.   |
| `--cpus <n>`              | CPUs for each job's VM. Defaults to an even share of the Mac's cores.        |
| `--memory <gb>`           | Memory for each job's VM. Defaults to an even share of half the Mac's.       |
| `--image <image>`         | Your own runner image for the VMs, used with the tools it has.               |
| `--local-network`         | Let jobs in VMs reach your Mac and your local network.                       |
| `--no-isolated`           | Run jobs on the Mac itself, where they can read your files.                  |
| `--isolated`              | Stop with an error when jobs can't run in VMs, where the default falls back. |
| `--events`                | For apps that run `connect`. See [Events](#events).                          |

The VM flags apply to Macs with Apple silicon. See [Isolated jobs on a Mac](/docs/runners/self-hosted#isolated-jobs-on-a-mac).

Only one `connect` runs on a computer at a time. A second one stops and says so.

### Events

With `--events`, `connect` writes one JSON object per line to stdout and nothing else; what it would print for you goes to stderr. Send `pause` or `resume` on stdin, one per line. To go offline as Ctrl-C does, start it in its own process group and send that group SIGINT. Closing stdin also takes it offline.

```json
{
  "v": 1,
  "at": "2026-11-16T18:00:00.000Z",
  "type": "state",
  "link": "online",
  "paused": false,
  "jobs": [],
  "waiting": 1,
  "queue": [{ "repo": "acme/app", "since": 1763481600000 }],
  "spilled": [],
  "slots": 2
}
```

Types: `sign-in` (the page and code to approve), `machine`, `state`, `job-repo`, `job-result`, `job-end` (the job's line in [`history`](#history)), `offline`, `error`, and the connection's own: `connecting`, `connected`, `disconnected`, `run`, `job`, `paused`, `waiting`. `waiting` (also in `state`) is how many jobs are queued for a slot on this machine: jobs it could run whose machines are all busy. `queue` lists the longest-waiting of them (repo, since when in ms, and the job's name and workflow once GitHub has said which job it is), and `spilled` holds when jobs in the last hour went to another runner because every slot was busy. `state` also has `slots`, how many jobs it runs at once. A `run` event carries `job` when the gateway knows which job it is: its name, workflow, repo, GitHub link and `typicalMs`, how long it usually takes on this machine.

## `login`

```sh
relayrunner login
```

Signs this machine in and exits, without putting it online. For agents and scripts. Takes `--name` and `--share` like `connect`.

## `whoami`

```sh
relayrunner whoami [--json]
```

Shows the machine, the workspaces it's in, who enrolled it, its sharing setting and whether it's online.

## `init`

```sh
relayrunner init [--plan] [--apply <jobs>] [--auto] [--json]
```

Routes a repo's jobs through RelayRunner. Run it inside a checkout. See [Move your workflows over](/docs/get-started/move-over).

| Flag             | What it does                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--plan`         | List the jobs and what would happen. Changes nothing.                                                                                      |
| `--apply <jobs>` | Route these jobs without prompting: ids (`test`), `file:id` (`ci.yml:test`), or `all`.                                                     |
| `--auto`         | Write `auto` instead of the label for Linux x64 jobs, so you set their [size](/docs/reference/relay-inputs#auto-sizes) on the Router page. |
| `--json`         | Print the result as JSON.                                                                                                                  |

## `pause` and `resume`

```sh
relayrunner pause
relayrunner resume
```

Stops new jobs reaching this machine while it stays connected, and lets them through again. A running job finishes.

## `share`

```sh
relayrunner share               # show the current setting
relayrunner share only-me       # only jobs you started
relayrunner share anyone        # any job in the workspace
```

## `workspaces`

```sh
relayrunner workspaces                # which workspaces this machine runs jobs in
relayrunner workspaces add acme       # run jobs from Acme here too
relayrunner workspaces remove acme    # stop running Acme's jobs here
```

You pick the machine's workspaces when you approve it; this changes them later. `add` and `remove` take a workspace's name, slug or id, or show a list to pick from when you leave it out. Adding a workspace while sharing is `anyone` warns that anyone who can push to its private repos can run jobs on the machine.

See the [changelog](/docs/changelog) for what's new.

## `history`

```sh
relayrunner history              # the last 20 jobs this machine ran
relayrunner history --limit 50
relayrunner history --json
```

Lists the jobs `connect` ran on this machine, newest first, with each one's result and how long it took. They're kept in `~/.relayrunner/history.jsonl`, the newest 500 at least, which the Mac app reads too.

## `blacksmith`

```sh
relayrunner blacksmith connect
relayrunner blacksmith connect --workspace acme   # when you run more than one workspace
```

Connects your Blacksmith organization so Settings › Providers shows its real usage: billable minutes and cost per day, and each job's billable minutes. Blacksmith has no usage API, so RelayRunner reads it with Blacksmith's own CLI and an org token.

The command runs `blacksmith org-token create`, which opens your browser for you to approve as an admin of the Blacksmith organization. It sends only the token it prints to RelayRunner, encrypted at rest, and never signs in to Blacksmith or reads Blacksmith's saved credentials. If Blacksmith's CLI isn't installed, it offers to download it into `~/.relayrunner/bin` (`--yes` skips the question), checked against the SHA-256 Blacksmith publishes.

The token goes to the workspace on the same GitHub organization, or the one you name. You must own or administer it. Remove the connection in Settings › Providers, then revoke the token with `blacksmith org-token revoke <id>`. Run `relayrunner login` first if this computer isn't signed in.

## `firewall`

```sh
relayrunner firewall        # show whether it's on
relayrunner firewall on     # asks for your password
relayrunner firewall off
```

Turns on a firewall on your Mac for [isolated jobs](/docs/runners/self-hosted#isolated-jobs-on-a-mac). Job VMs can reach the internet, not your Mac or your local network, and no job can remove it. It stays on after a restart.
