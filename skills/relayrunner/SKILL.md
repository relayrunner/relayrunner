---
name: relayrunner
description: Set up and run RelayRunner from the command line. Use when the user wants to run their GitHub Actions jobs on their own Mac or Linux computer, sign a machine in, put it online or take it offline, pause it, share it with teammates, change its workspaces, size or isolate jobs on a Mac, turn on the Mac firewall, set up relayrunner.yml checks, or fix a machine that isn't taking jobs. Covers the `relayrunner` CLI (`npx relayrunner`).
license: Apache-2.0
---

# RelayRunner CLI

RelayRunner routes GitHub Actions jobs to the first free runner in a workspace's runner order: the user's own machines, hosted runner providers, or GitHub-hosted runners. The `relayrunner` CLI connects a Mac or Linux computer as one of those machines. Workflows stay on GitHub Actions, and a routed job falls back to its usual runner when no machine is free.

To route a repo's jobs (relay jobs and `runs-on`), use the `relayrunner-route-jobs` skill. To answer questions about runs, runners or usage, use `relayrunner-ci-insights`.

## How to work

- Use the CLI. Check `relayrunner <command> --help` for a flag you aren't sure of instead of guessing.
- Add `--json` where a command has it (`whoami`, `init`, `workspaces`) and read that instead of prose.
- Explain each step in a sentence before you run it.
- Machines only take jobs from private repos. Don't try to work around that.
- Leave sharing and workspaces to the user. Ask before `share anyone` or `workspaces add`.
- For details, fetch the docs as Markdown: any page under https://relayrunner.app/docs with `.md` added.

## Install

macOS or Linux, x64 or ARM64, with Node.js 22 or newer. Windows isn't supported yet.

```sh
npm install --global relayrunner@latest
relayrunner --help
```

Or use `npx relayrunner@latest <command>` without installing.

## Sign the machine in

```sh
relayrunner whoami --json
```

- `status` `"ok"`: signed in. Tell the user the machine's name and workspaces.
- `status` `"signed_out"` or `"revoked"`: run `relayrunner login`.
- `status` `"unverified"`: the gateway couldn't be reached. Say so and try again.

```sh
relayrunner login
```

`login` prints a URL and a code, opens the browser, and waits (up to 30 minutes) while the user signs in with GitHub, installs the RelayRunner GitHub App if they haven't, and approves the machine. Give the user the URL and code before you wait. `login` exits once approved; it doesn't put the machine online.

A new machine only runs jobs the user started. If they want teammates' jobs on it too, run `relayrunner share anyone` (`share only-me` undoes it), or pass `--share` to `login`.

## Put the machine online

`relayrunner connect` is the on/off switch. While it runs, the machine takes jobs. Ctrl-C takes it offline, and jobs go back to their usual runners.

`connect` keeps running, so suggest the user start it in their own terminal, where it outlives your session. If you start it, run it in the background and tell the user it stops when your session ends.

`--concurrency <n>` sets how many jobs run at once (default 2 with 8+ CPU cores, else 1). `--name` and `--share` answer the first sign-in's questions.

## Isolated jobs on a Mac

On a Mac with Apple silicon, macOS 26 and Apple's `container` tool (started once with `container system start`), each job runs in its own Linux VM that can't see the user's files or reach their Mac or local network. Elsewhere jobs run on the machine itself, as the user who started `connect`. Flags:

- `--cpus <n>` and `--memory <gb>`: a fixed size for every job's VM.
- `--macos`: also take macOS jobs, which run on the Mac itself, not in a VM. Only for repos the user trusts.
- `--local-network`: let job VMs reach the Mac and local network.
- `--image <image>`: start VMs from the user's own runner image.
- `--no-isolated`: run jobs on the Mac itself, where they can read the user's files.
- `--isolated`: fail instead of falling back when VMs aren't available.

`relayrunner firewall on` adds a block no job can remove (it asks for the user's password; `firewall off` removes it). Docs: https://relayrunner.app/docs/runners/self-hosted.md

## Everyday commands

```sh
relayrunner pause              # stay connected, take no new jobs
relayrunner resume
relayrunner share              # show who can run jobs here
relayrunner workspaces --json  # which workspaces this machine takes jobs from
relayrunner workspaces add     # or remove; takes a name, slug or id
```

## Optimized checks

A `relayrunner.yml` file at `.github/relayrunner.yml` or the repo root turns on a PR title check and linters for every pull request, with no workflow and no runner. It's read from the default branch.

```yaml
checks:
  pr-title: true
  lint: [oxlint, typos]
```

Suggest only linters the repo already uses or would pass. Docs: https://relayrunner.app/docs/reference/repo-config.md

## When something's wrong

Fetch https://relayrunner.app/docs/reference/troubleshooting.md and match the error. For why one job ran where it did, use `relayrunner-ci-insights` or the job's **Show why** on the dashboard's Activity page. On a Mac, `~/.relayrunner/isolated.log` has VM details with no job output or credentials.
