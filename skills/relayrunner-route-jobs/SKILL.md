---
name: relayrunner-route-jobs
description: Move a repo's GitHub Actions jobs onto RelayRunner, so they run on the user's own machines or a hosted runner provider with GitHub-hosted runners as the fallback. Use when the user wants to route jobs, change `runs-on` to RelayRunner, add a relay job, cut GitHub Actions minutes by running CI on their own computer, understand why `relayrunner init` skipped a job, route a skipped job by hand, or undo routing. Covers `relayrunner init` and the relay workflow.
license: Apache-2.0
---

# Route jobs through RelayRunner

Routing a job is one change: a relay job in front of it, and a `runs-on` that points at the relay's answer. The relay asks RelayRunner where the job should run and finishes in about a second without a runner. The job's old label stays as the fallback.

`relayrunner init` makes that change. It decides which jobs are safe to route and writes the YAML, keeping comments and formatting. Use it instead of writing relay YAML from memory, and only hand-edit a job `init` skipped when the user asks.

Work in the user's checkout and ask before changing files. `init` never commits; leave committing and pushing to the user unless they ask. If the CLI isn't installed, see the `relayrunner` skill.

## 1. Plan

```sh
relayrunner init --plan --json
```

This changes nothing. It returns the repo, its `visibility`, the `relay` version, and one entry per job:

```json
{ "file": ".github/workflows/ci.yml", "job": "test", "verdict": "ready", "provider": "github", "label": "ubuntu-latest", "machine": "self-hosted", "warnings": [] }
{ "file": ".github/workflows/deploy.yml", "job": "deploy", "verdict": "skipped", "reason": "looks like a deploy job (environment)", "warnings": [] }
```

- `"refused": "public_repo"`: stop. Machines never take a public repo's jobs. Tell the user.
- `visibility` `"unknown"`: ask the user, or run `gh repo view --json visibility`. Only private repos route to machines.
- `{ "error": ... }`: tell the user. Usually the folder isn't a git checkout.
- Anything in `errors` is a workflow file the CLI couldn't parse. Mention it.

## 2. Go over the jobs

Group them by `verdict`, in plain words:

- **ready**: can be routed. Say where it runs when no machine is free: `label` on `provider`. A job with `machine` `macOS` only goes to Macs that take macOS jobs. Read out each warning, such as a job that needs Docker.
- **routed**: already goes through RelayRunner.
- **skipped**: left alone, with its `reason`. See [references/skipped-jobs.md](references/skipped-jobs.md) for whether it can be routed by hand.

Suggest every ready job, minus any whose warnings the user would rather not deal with.

## 3. Apply

```sh
relayrunner init --apply test,lint --json
```

Name jobs by id (`test`), or `file:id` (`ci.yml:test`) when an id is in more than one workflow. `all` routes every ready job.

Then show `git diff` and explain it. Each routed job looks like this:

```yaml
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1.0.0-beta.5
    with:
      machine: self-hosted
      github: ubuntu-latest

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
```

The check keeps its name in GitHub, so required checks keep working. The relay takes one input per provider the job may use (`machine`, `github`, or a hosted provider such as `depot`); see https://relayrunner.app/docs/reference/relay-inputs.md. Which provider is tried first is the workspace's runner order, set on the dashboard's Router page.

## 4. Confirm it works

Once pushed, with `relayrunner connect` running, the run shows `relay-<job> / RelayRunner` finishing in about a second, then the job. A runner name starting with the machine's name (from `relayrunner whoami`) means it ran on the machine; a GitHub-hosted name means the fallback. If the relay stays queued, the GitHub App probably isn't installed on the repo's owner: see https://relayrunner.app/docs/reference/troubleshooting.md.

## Undo

Delete the relay job and its `needs` entry, and put the old label back in `runs-on`. Leaving it is also fine: with no machine online, jobs run on their fallback label.
