---
title: CLI
description: Every relayrunner command and flag.
---

The `relayrunner` CLI runs on macOS and Linux with Node.js 22 or newer. Run it with `npx relayrunner <command>`, or install it with `npm install --global relayrunner`. See [Install](/docs/get-started/install). On a Mac, [RelayRunner for Mac](/docs/get-started/mac-app) runs `connect` for you from the menu bar.

## `connect`

```sh
relayrunner connect
```

Puts this machine online and runs the jobs it's sent until you stop it. The first run signs the machine in. Ctrl-C takes it offline, and a job that's running stops with it. Press `p` to pause or resume.

On a Mac with Apple silicon and Apple's container tool, each job runs in its own Linux VM. Elsewhere jobs run on the machine itself. While `connect` stays open, it switches to newer GitHub runners between jobs.

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

Event types:

- `sign-in`: the page and code to approve.
- `machine`, `state`, `offline` and `error`.
- `job-repo`, `job-result` and `job-end`, which is the job's line in [`history`](#history).
- The connection's own: `connecting`, `connected`, `disconnected`, `run`, `job`, `paused` and `waiting`.

A `state` event has:

- `waiting`: how many jobs are queued for a slot on this machine. It's also an event of its own.
- `queue`: the longest-waiting of them, each with its repo, `since` in ms, and the job's name and workflow once GitHub has said which job it is.
- `spilled`: when jobs in the last hour went to another runner because every slot was busy.
- `slots`: how many jobs the machine runs at once.

A `run` event carries `job` when the job is known: its name, workflow, repo, GitHub link and `typicalMs`, how long it usually takes on this machine.

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
relayrunner init [--plan] [--apply <jobs>] [--exact] [--allow-deploy <jobs>] [--json]
```

Routes a repo's jobs through RelayRunner. Run it inside a checkout. See [Move your workflows over](/docs/get-started/move-over).

| Flag                    | What it does                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plan`                | List the jobs and what would happen. Changes nothing.                                                                                                                              |
| `--apply <jobs>`        | Route these jobs without prompting: ids (`test`), `file:id` (`ci.yml:test`), or `all`.                                                                                             |
| `--exact`               | Keep each job's label under its provider's input instead of writing its [shape](/docs/reference/relay-inputs#what-the-job-needs), so only that provider and your machines take it. |
| `--allow-deploy <jobs>` | Route these jobs even though they look like deploy jobs. The machine gets their secrets and cloud access.                                                                          |
| `--json`                | Print the result as JSON.                                                                                                                                                          |

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

You pick the machine's workspaces when you approve it, and this command changes them later. `add` and `remove` take a workspace's name, slug or id, or show a list to pick from when you leave it out. Adding a workspace while sharing is `anyone` warns that anyone who can push to its private repos can run jobs on the machine.

## `history`

```sh
relayrunner history              # the last 20 jobs this machine ran
relayrunner history --limit 50
relayrunner history --json
```

Lists the jobs `connect` ran on this machine, newest first, with each one's result and how long it took. They're kept in `~/.relayrunner/history.jsonl`, the newest 500 at least, which the Mac app reads too.

## `benchmark`

```sh
relayrunner benchmark depot                                  # in a clone: pick a workflow, then start
relayrunner benchmark depot --workflow ci.yml --vcpus 8      # skip the questions you've answered
relayrunner benchmark depot --workflow ci.yml --yes --json   # for scripts and CI
relayrunner benchmark watch                                  # follow the one running now
relayrunner benchmark list --provider depot                  # the last 30 days
relayrunner benchmark stop <id>
```

Evaluates a hosted provider on one of your workflows. It runs the whole workflow five times on that provider, on the same commit from the default branch (a cold cache first, then warm), and compares it with the workflow's last 20 passing runs. The runs bill to your account with the provider.

It's the same evaluation as the provider's Evaluate page in the dashboard. The command prints a link where you can follow it, and `benchmark watch` follows one you started in the dashboard. `relayrunner eval`, its old name, still works.

In a clone, the command uses that repo and the workspace on its GitHub account. `--repo` and `--workspace` pick others. Before it starts, it may give you a step to do:

- **Install the provider's GitHub App.** On an organization, the command waits until the App is there. On a personal account, you confirm it yourself.
- **Route the workflow** with `relayrunner init`, if its jobs don't go through a relay.
- **Add `workflow_dispatch`** to the workflow. The command shows the line to add, and starts after the next push to the default branch.

While it runs, `s` stops it and keeps the runs that finished, `o` opens it in the dashboard, and Ctrl-C leaves it running. Only workspace owners and admins can start or stop one. If this computer isn't signed in, the command signs you in first. An evaluation only sees runs from after the RelayRunner GitHub App was installed, so in a new account, route a workflow and push before evaluating it.

| Exit code | When                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0         | All five runs passed, you stopped it after at least one passed, or `--detach` started it                                       |
| 1         | A run failed, or GitHub or RelayRunner refused it                                                                              |
| 2         | Bad flags, or `--yes` is missing off a terminal                                                                                |
| 3         | You have a step to do first: install the provider's app, route the workflow, add `workflow_dispatch`, or ask an owner or admin |
| 130       | Ctrl-C. The evaluation keeps running                                                                                           |

## `blacksmith`

```sh
relayrunner blacksmith connect
relayrunner blacksmith connect --workspace acme   # when you run more than one workspace
```

Connects your Blacksmith organization so Settings › Providers shows its real usage: billable minutes and cost per day, and each job's billable minutes. You must own or administer the workspace, and the computer must be signed in (`relayrunner login`).

The command runs `blacksmith org-token create`, which opens your browser. Approve it as an admin of the Blacksmith organization, for the GitHub organization your workspace is on. A token for any other organization is refused.

Only the token goes to RelayRunner, where it's stored encrypted. The command never reads Blacksmith's saved credentials. If Blacksmith's CLI isn't installed, the command offers to download it into `~/.relayrunner/bin`, checked against the SHA-256 Blacksmith publishes (`--yes` skips the question).

To disconnect, remove the connection in Settings › Providers, then revoke the token with `blacksmith org-token revoke <id>`.

## `feedback`

```sh
relayrunner feedback "The Jobs window doesn't show yesterday's jobs"
relayrunner feedback --category bug --file report.txt
relayrunner feedback --anonymous "The menu icon stays faded"
```

Sends a message to the RelayRunner team with your name and email, so we can reply. `--anonymous` sends it without them. `--category` is `bug`, `confusing`, `feature_request` or `other` (the default). Anything that looks like a token or password is replaced before it's stored. The Mac app sends crash reports this way, after you've seen what's in them, and anonymously unless you choose to include your name and email.

## `firewall`

```sh
relayrunner firewall        # show whether it's on
relayrunner firewall on     # asks for your password
relayrunner firewall off
```

Turns on a firewall on your Mac for [isolated jobs](/docs/runners/self-hosted#isolated-jobs-on-a-mac). Job VMs can reach the internet, not your Mac or your local network, and no job can remove it. It stays on after a restart.

See the [changelog](/docs/changelog) for what's new.
