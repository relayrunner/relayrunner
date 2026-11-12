---
title: CLI
description: Every relayrunner command and flag.
---

The `relayrunner` CLI runs on macOS and Linux with Node.js 22 or newer. Run it with `npx relayrunner <command>`, or install it with `npm install --global relayrunner`. See [Install](/docs/get-started/install).

## `connect`

```sh
relayrunner connect
```

Puts this machine online and runs the jobs it's sent until you stop it. It runs up to 2 jobs at once on a computer with 8 or more CPU cores, otherwise 1; `--concurrency` changes that. The first run signs the machine in. Ctrl-C takes it offline, and a job that's running stops with it. Press `p` to pause or resume.

Run inside a repo with no routed jobs, it offers to route them, the same as `init`.

| Flag                      | What it does                                                             |
| ------------------------- | ------------------------------------------------------------------------ |
| `--name <name>`           | The machine's name. Defaults to the computer's name.                     |
| `--share only-me\|anyone` | Who can run jobs on this machine.                                        |
| `--concurrency <n>`       | How many jobs to run at once. Defaults to 2 with 8+ CPU cores, else 1.   |
| `--isolated`              | Experimental. Run each job in its own Linux VM. Apple silicon Macs only. |
| `--image <image>`         | With `--isolated`, your own runner image, used with the tools it has.    |
| `--local-network`         | With `--isolated`, let jobs reach your Mac and your local network.       |
| `--macos`                 | With `--isolated`, also take macOS jobs, which run on the Mac itself.    |

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
relayrunner init [--plan] [--apply <jobs>] [--json]
```

Routes a repo's jobs through RelayRunner. Run it inside a checkout. See [Move your workflows over](/docs/get-started/move-over).

| Flag             | What it does                                                                           |
| ---------------- | -------------------------------------------------------------------------------------- |
| `--plan`         | List the jobs and what would happen. Changes nothing.                                  |
| `--apply <jobs>` | Route these jobs without prompting: ids (`test`), `file:id` (`ci.yml:test`), or `all`. |
| `--json`         | Print the result as JSON.                                                              |

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

See the [changelog](https://github.com/relayrunner/relayrunner/blob/main/apps/cli/CHANGELOG.md) for what's new.

## `firewall`

```sh
relayrunner firewall        # show whether it's on
relayrunner firewall on     # asks for your password
relayrunner firewall off
```

Turns on a firewall on your Mac for [isolated jobs](/docs/runners/self-hosted#isolated-jobs-on-a-mac). Job VMs can reach the internet, not your Mac or your local network, and no job can remove it. It stays on after a restart.
