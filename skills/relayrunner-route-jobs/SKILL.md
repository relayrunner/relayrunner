---
name: relayrunner-route-jobs
description: Move a repo's GitHub Actions jobs onto RelayRunner, so they run on the user's own machines or a hosted runner provider with GitHub-hosted runners as the fallback. Use when the user wants to route jobs, change `runs-on` to RelayRunner, add a relay job, cut GitHub Actions minutes by running CI on their own computer, open a PR that routes a repo's jobs, understand why `relayrunner init` skipped a job, route a skipped job by hand, or undo routing. Covers `relayrunner init`, the relay workflow, and the PR that ships it.
license: Apache-2.0
---

# Route jobs through RelayRunner

Routing a job is one change: a relay job in front of it, and a `runs-on` that points at the relay's answer. The relay asks RelayRunner where the job should run and finishes in about a second without a runner. It says what the job needs (its OS, and its arch and CPUs when they aren't standard), read from the job's old label, so any of the user's machines or providers on the Router page can take it.

`relayrunner init` makes that change. It decides which jobs are safe to route and writes the YAML, keeping comments and formatting. Use it instead of writing relay YAML from memory, and only hand-edit a job `init` skipped when the user asks.

Work in the user's checkout and ask before changing files. `init` never commits; step 4 covers the commit and PR. If the CLI isn't installed, see the `relayrunner` skill.

If the user isn't sure which repo to start with, the `list_workflows` MCP tool (see `relayrunner-ci-insights`) lists recent workflows with the ones not routed yet first, as does the dashboard's Router page.

## 1. Plan

```sh
relayrunner init --plan --json
```

This changes nothing. It returns the repo, its `visibility`, the `relay` version, and one entry per job:

```json
{ "file": ".github/workflows/ci.yml", "job": "test", "verdict": "ready", "provider": "github", "label": "ubuntu-latest", "machine": "self-hosted", "shape": { "os": "linux" }, "warnings": [] }
{ "file": ".github/workflows/deploy.yml", "job": "deploy", "verdict": "skipped", "reason": "looks like a deploy job (environment)", "warnings": [] }
```

- `"refused": "public_repo"`: stop. Machines never take a public repo's jobs. Tell the user.
- `visibility` `"unknown"`: ask the user, or run `gh repo view --json visibility`. Only private repos route to machines.
- `{ "error": ... }`: tell the user. Usually the folder isn't a git checkout.
- Anything in `errors` is a workflow file the CLI couldn't parse. Mention it.

## 2. Go over the jobs

Group them by `verdict`, in plain words:

- **ready**: can be routed. Say what it will ask for, from `shape`: `os`, plus `arch` when it isn't the usual one and `cpus` when the old `label` was bigger than a standard 2 CPU runner. A macOS job only goes to Macs and to providers with macOS runners. Read out each warning, such as a job that needs Docker.
- **routed**: already goes through RelayRunner.
- **skipped**: left alone, with its `reason`. For each, say whether it can be routed anyway, using [references/skipped-jobs.md](references/skipped-jobs.md). Deploy jobs, and jobs pinned to a label list such as `[self-hosted, m1, macmini]` or a runner group, often can.

Suggest every ready job, minus any whose warnings the user would rather not deal with.

## 3. Apply

```sh
relayrunner init --apply test,lint --json
```

Name jobs by id (`test`), or `file:id` (`ci.yml:test`) when an id is in more than one workflow. `all` routes every ready job. Each routed job's `with` field lists the relay inputs it got. Add `--exact` only when the user wants a job kept on its old provider: the relay then gets `machine` and the old label under its provider (such as `github: ubuntu-latest`), and no other provider takes it.

To route a job skipped as a deploy job, once the user has said its machine may have the job's secrets and cloud access, name it in `--allow-deploy` as well as `--apply`:

```sh
relayrunner init --apply test,checks --allow-deploy checks --json
```

`--allow-deploy` only lifts the deploy check. Never add it on your own judgment.

Then show `git diff` and explain it. Each routed job looks like this:

```yaml
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1
    with:
      os: linux

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
```

The check keeps its name in GitHub, so required checks keep working. `os` is `linux` or `macos`. `arch: arm64` (Linux) or `arch: x64` (Intel macOS) appears only when the old label asked for it, and `cpus: 8` only when it asked for more than 2. Without `cpus`, the job's size is the one picked on the dashboard's Router page, so it can change without a commit. Which provider is tried first is the workspace's runner order, also on the Router page. A relay can instead name a provider's label (`github: ubuntu-latest`, `blacksmith: blacksmith-4vcpu-ubuntu-2404`), which pins the job to that label; see https://relayrunner.dev/docs/reference/relay-inputs.md.

### Offer pull request checks

If the repo has no `relayrunner.yml` (in `.github/` or the root), offer to add one with pull request checks in the same PR. They run on every pull request with no runner and no billed minute, in any repo, public ones included:

```yaml
# .github/relayrunner.yml
checks:
  pr-title: true # the PR title must be a Conventional Commit
  pr-description: true # the PR must have a description
```

Suggest `pr-title` only when the repo's recent commits or PR titles already follow Conventional Commits (`git log --oneline -20`), and say which types they use if they stick to a few (`pr-title: { types: [feat, fix, docs] }`). `pr-description` suits any repo. Add the file only if the user says yes, and leave out `lint` unless they ask: it's in preview. The checks read the file from the default branch, so they start once the PR merges. Docs: https://relayrunner.dev/docs/concepts/optimized-checks.md

## 4. Open a PR

A routed job does nothing until its change is pushed, so the diff isn't the end.

- **The user asked for a PR**: open it once they OK the diff.
- **They didn't**: end the diff message with "Open a PR with this?" and open it when they say yes. Saying yes to the edit isn't a yes to pushing it, so don't commit or push before that.
- **They said not to commit**, or want to commit themselves: stop at the diff.

Never merge the PR.

```sh
git switch -c relayrunner/route-jobs
git add .github/workflows .github/relayrunner.yml
git commit -m "ci: route jobs through RelayRunner"
git push -u origin relayrunner/route-jobs
gh pr create --title "ci: route jobs through RelayRunner" --body-file <body.md>
```

Follow the repo's own branch, commit and PR template conventions where it has them. If `relayrunner/route-jobs` already exists, add `-2`. If the push is refused because the token can't change workflows, have the user run `gh auth refresh -h github.com -s workflow`. Without `gh`, give the user the compare link that `git push` prints.

The PR body lists what changed and what didn't, from the `--apply` and `--plan` output:

```md
Routes these jobs through RelayRunner. Each runs on a connected machine when one is free, and otherwise on the next runner in the workspace's runner order that fits.

| Job             | Asks for       | Was           | Check first                               |
| --------------- | -------------- | ------------- | ----------------------------------------- |
| ci.yml › test   | Linux          | ubuntu-latest |                                           |
| ci.yml › checks | Linux, 4+ CPUs | ubuntu-latest | can request OIDC tokens (id-token: write) |

Left alone:

| Job                 | Why                                   |
| ------------------- | ------------------------------------- |
| deploy.yml › deploy | looks like a deploy job (environment) |
| ci.yml › mac        | runs-on is a list of labels           |

Logs and required checks stay in GitHub. To undo, revert this PR.
```

If the PR adds `relayrunner.yml`, add a line saying which checks it turns on and that they start after merge.

## 5. Confirm it works

The PR's own checks are the first routed run. With `relayrunner connect` running, the run shows `relay-<job> / RelayRunner` finishing in about a second, then the job. A runner name starting with the machine's name (from `relayrunner whoami`) means it ran on the machine; a GitHub-hosted name means the fallback. If the relay stays queued, the GitHub App probably isn't installed on the repo's owner: see https://relayrunner.dev/docs/reference/troubleshooting.md.

## Undo

Delete the relay job and its `needs` entry, and put the old label back in `runs-on`. Leaving it is also fine: with no machine online, jobs run on the providers in the runner order.
