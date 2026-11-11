---
title: CLI
description: Every relayrunner command and flag.
---

The `relayrunner` CLI runs on macOS and Linux (x64 or ARM64) with Node.js 22 or newer. Run it with `npx relayrunner <command>`, or install it with `npm install --global relayrunner`. See [Install](/docs/get-started/install/).

## `connect`

```sh
relayrunner connect
```

Puts this machine online and runs the jobs it's sent, one at a time, until you stop it. The first run signs the machine in. Ctrl-C takes it offline, and a job that's running stops with it. Press `p` to pause or resume.

Run inside a private repo where no job is routed yet, it offers to set the repo up, the same as `init`.

| Flag                      | What it does                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `--name <name>`           | The name suggested at sign-in. Defaults to the hostname, or the Mac's Computer Name. |
| `--share only-me\|anyone` | Who can run jobs on this machine.                                                    |
| `--server <url>`          | Another gateway. Also `RELAYRUNNER_URL`.                                             |

## `login`

```sh
relayrunner login
```

Signs this machine in and exits, without putting it online. For agents and scripts. Takes `--name`, `--share` and `--server` like `connect`.

## `whoami`

```sh
relayrunner whoami [--json]
```

Shows the machine, its workspace, who enrolled it, its sharing setting and whether it's online. Exits 1 when not signed in or removed. If the gateway can't be reached, it prints what's saved locally, marked unverified.

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

## Files and environment

|                               |                                               |
| ----------------------------- | --------------------------------------------- |
| `~/.relayrunner/machine.json` | The machine's token.                          |
| `~/.relayrunner/runner/`      | GitHub's runner, downloaded on first connect. |
| `RELAYRUNNER_HOME`            | Keep everything in another folder.            |
| `RELAYRUNNER_URL`             | Another gateway, as `--server`.               |

See the [changelog](https://github.com/relayrunner/relayrunner/blob/main/apps/cli/CHANGELOG.md) for what's new.
