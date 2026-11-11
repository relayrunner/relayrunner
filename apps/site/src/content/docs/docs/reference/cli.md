---
title: CLI
description: Every relayrunner command and flag.
---

The `relayrunner` CLI runs on macOS and Linux with Node.js 22 or newer. Run it with `npx relayrunner <command>`, or install it with `npm install --global relayrunner`. See [Install](/docs/get-started/install/).

## `connect`

```sh
relayrunner connect
```

Puts this machine online and runs the jobs it's sent, one at a time, until you stop it. The first run signs the machine in. Ctrl-C takes it offline, and a job that's running stops with it. Press `p` to pause or resume.

Run inside a repo with no routed jobs, it offers to route them, the same as `init`.

| Flag                      | What it does                                         |
| ------------------------- | ---------------------------------------------------- |
| `--name <name>`           | The machine's name. Defaults to the computer's name. |
| `--share only-me\|anyone` | Who can run jobs on this machine.                    |

## `login`

```sh
relayrunner login
```

Signs this machine in and exits, without putting it online. For agents and scripts. Takes `--name` and `--share` like `connect`.

## `whoami`

```sh
relayrunner whoami [--json]
```

Shows the machine, its workspace, who enrolled it, its sharing setting and whether it's online.

## `init`

```sh
relayrunner init [--plan] [--apply <jobs>] [--json]
```

Routes a repo's jobs through RelayRunner. Run it inside a checkout. See [Move your workflows over](/docs/get-started/move-over/).

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

See the [changelog](https://github.com/relayrunner/relayrunner/blob/main/apps/cli/CHANGELOG.md) for what's new.
