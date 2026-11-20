---
name: relayrunner-route-jobs
description: Move a repo's GitHub Actions jobs onto RelayRunner, so they run on the user's own machines or a hosted runner provider with GitHub-hosted runners as the fallback. Use when the user wants to route jobs, change `runs-on` to RelayRunner, add a relay job, cut GitHub Actions minutes by running CI on their own computer, open a PR that routes a repo's jobs, understand why `relayrunner init` skipped a job, route a skipped job by hand, or undo routing. Covers `relayrunner init`, the relay workflow, and the PR that ships it.
license: Apache-2.0
---

# Route jobs through RelayRunner

Routing a job is one change: a relay job in front of it, and a `runs-on` that points at the relay's answer. The relay asks RelayRunner where the job should run and finishes in about a second without a runner. The job's old label stays as the fallback.

`relayrunner init` makes that change. It decides which jobs are safe to route and writes the YAML, keeping comments and formatting. Use it instead of writing relay YAML from memory, and only hand-edit a job `init` skipped when the user asks.

Work in the user's checkout and ask before changing files. `init` never commits; step 4 covers the commit and PR. If the CLI isn't installed, see the `relayrunner` skill.

If the user isn't sure which repo to start with, the `list_workflows` MCP tool (see `relayrunner-ci-insights`) lists recent workflows with the ones not routed yet first, as does the dashboard's Router page.

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
- **skipped**: left alone, with its `reason`. For each, say whether it can be routed anyway, using [references/skipped-jobs.md](references/skipped-jobs.md). Deploy jobs, and jobs pinned to a label list such as `[self-hosted, m1, macmini]` or a runner group, often can.

Suggest every ready job, minus any whose warnings the user would rather not deal with.

## 3. Apply

```sh
relayrunner init --apply test,lint --json
```

Name jobs by id (`test`), or `file:id` (`ci.yml:test`) when an id is in more than one workflow. `all` routes every ready job. Add `--auto` when the user wants to set sizes on the Router page: Linux x64 jobs get `auto` instead of their label, and each routed job's `auto` field says which did.

To route a job skipped as a deploy job, once the user has said its machine may have the job's secrets and cloud access, name it in `--allow-deploy` as well as `--apply`:

```sh
relayrunner init --apply test,checks --allow-deploy checks --json
```

`--allow-deploy` only lifts the deploy check. Never add it on your own judgment.

Then show `git diff` and explain it. Each routed job looks like this:

```yaml
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1.0.0-beta.8
    with:
      machine: self-hosted
      github: ubuntu-latest

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
```

The check keeps its name in GitHub, so required checks keep working. The relay takes one input per provider the job may use (`machine`, `github`, or a hosted provider such as `depot`); see https://relayrunner.dev/docs/reference/relay-inputs.md. Which provider is tried first is the workspace's runner order, set on the dashboard's Router page. A provider set to `auto` (such as `blacksmith: auto`) lets the Router page pick the job's size, so it can change without a commit; a label written there runs as written.

## 4. Open a PR

A routed job does nothing until its change is pushed, so the diff isn't the end.

- **The user asked for a PR**: open it once they OK the diff.
- **They didn't**: end the diff message with "Open a PR with this?" and open it when they say yes. Saying yes to the edit isn't a yes to pushing it, so don't commit or push before that.
- **They said not to commit**, or want to commit themselves: stop at the diff.

Never merge the PR.

```sh
git switch -c relayrunner/route-jobs
git add .github/workflows
git commit -m "ci: route jobs through RelayRunner"
git push -u origin relayrunner/route-jobs
gh pr create --title "ci: route jobs through RelayRunner" --body-file <body.md>
```

Follow the repo's own branch, commit and PR template conventions where it has them. If `relayrunner/route-jobs` already exists, add `-2`. If the push is refused because the token can't change workflows, have the user run `gh auth refresh -h github.com -s workflow`. Without `gh`, give the user the compare link that `git push` prints.

The PR body lists what changed and what didn't, from the `--apply` and `--plan` output:

```md
Routes these jobs through RelayRunner. Each runs on a connected machine when one is free, and on its old label otherwise.

| Job             | Falls back to | Check first                               |
| --------------- | ------------- | ----------------------------------------- |
| ci.yml › test   | ubuntu-latest |                                           |
| ci.yml › checks | ubuntu-latest | can request OIDC tokens (id-token: write) |

Left alone:

| Job                 | Why                                   |
| ------------------- | ------------------------------------- |
| deploy.yml › deploy | looks like a deploy job (environment) |
| ci.yml › mac        | runs-on is a list of labels           |

Logs and required checks stay in GitHub. To undo, revert this PR.
```

## 5. Confirm it works

The PR's own checks are the first routed run. With `relayrunner connect` running, the run shows `relay-<job> / RelayRunner` finishing in about a second, then the job. A runner name starting with the machine's name (from `relayrunner whoami`) means it ran on the machine; a GitHub-hosted name means the fallback. If the relay stays queued, the GitHub App probably isn't installed on the repo's owner: see https://relayrunner.dev/docs/reference/troubleshooting.md.

## Undo

Delete the relay job and its `needs` entry, and put the old label back in `runs-on`. Leaving it is also fine: with no machine online, jobs run on their fallback label.
