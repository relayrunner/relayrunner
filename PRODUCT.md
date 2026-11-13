# RelayRunner product definition

RelayRunner is a hosted gateway for GitHub Actions. It sends each job to the first runner in a workspace's runner order that can take it: one of the team's own machines when one is online and free, an existing self-hosted runner, a hosted provider such as Blacksmith or Depot, or GitHub's hosted runners. Developers keep their usual push workflow and see the same checks and logs in GitHub Actions.

## The problem

Coding agents push often, and every push burns GitHub Actions minutes. Private projects don't want to pay for them, and many teams assume self-hosted runners mean dedicated machines that are always on. RelayRunner lets a team have both: their laptops and other machines take jobs while they're online, and GitHub-hosted runners (or another provider) take the rest, with no switch to flip.

## How it works

- **Workspaces connect GitHub orgs.** A user signs in with GitHub and creates a workspace. The RelayRunner GitHub App is installed on one or more organizations, and each installation belongs to one workspace.
- **A relay job routes each job.** A job opts in by adding a `relay` job from [`relayrunner/actions`](https://github.com/relayrunner/actions) and pointing its `runs-on` at the relay's output. The relay names one input per provider the job may use, such as `machine: macOS, ARM64`, `github: ubuntu-latest` or `blacksmith: blacksmith-2vcpu-ubuntu-2404`. RelayRunner answers the relay itself in about a second, so it uses no runner and bills no minutes.
- **The runner order decides.** RelayRunner walks the workspace's runner order and picks the first provider the job named that can take it now. A provider the job didn't name is never used, and a provider missing from the runner order is never used either. If nothing fits, the relay fails with the reason and the job doesn't start.
- **Some checks need no runner.** A job on `runs-on: relayrunner` whose steps are all RelayRunner checks, such as `checks/pr-title`, is answered by the gateway directly, with no runner and no billed minutes. `checks/lint` runs linters such as oxlint, ruff or actionlint on the commit in RelayRunner's own sandbox and posts a check run per tool; repos can also turn lint on for every pull request in `relayrunner.yml`. Lint needs the separate, opt-in RelayRunner Checks App.

## Runner providers

- **Self-hosted: connected machines.** `relayrunner connect` signs a machine in to a workspace and keeps it online while it runs. Each job gets a fresh one-job (JIT) runner, so the machine needs no permanent runner setup. A machine must have every label in the relay's `machine` input (`self-hosted` matches any machine). On an Apple silicon Mac, `connect --isolated` (experimental) runs each job in its own Linux VM that sees none of the user's files; the Mac then counts as a Linux machine.
- **Self-hosted: existing runners.** Owners and admins can add self-hosted runners an organization already has on GitHub, with no change on the runner's machine. They share the Self-hosted step of the runner order with connected machines.
- **Hosted providers.** Blacksmith, Depot, Namespace, WarpBuild, Ubicloud and RunsOn. RelayRunner hands the job the label from the provider's own relay input, such as `depot`. The provider's own GitHub App runs it.
- **GitHub-hosted.** The label from the relay's `github` input, usually the job's old `runs-on`.

## User experience

- **Set up once.** Install the GitHub App, run `relayrunner connect` on a machine, and add a relay job to each job that should be routed. `relayrunner init` does the workflow part, and an agent can drive the whole setup by following [docs/agent-install.md](docs/agent-install.md): it signs the machine in with `relayrunner login`, runs `init` for the jobs the user picks and shows the diff.
- **See where jobs ran.** The dashboard's Activity page lists each job, where it ran and why. The Usage page shows Actions minutes and what optimized checks saved.
- **Manage runners.** The Runners page shows machines, their labels and whether they're online, and sets the runner order. Pausing a machine (from the dashboard or `relayrunner pause`) stops new jobs reaching it while it stays connected.
- **Work as a team.** Membership comes from GitHub: anyone whose GitHub sign-in can see a workspace's installation is a member, and whoever installed the App is its owner. Owners set roles on the Members page. Settings → GitHub shows the workspace's installation.
- **Stop any time.** Pressing Ctrl-C in `relayrunner connect` takes the machine offline, and its jobs go to the next provider in the runner order with no workflow change.

## Product principles

- **Hosted runners stay the fallback.** A job that names a `github` or hosted provider label still runs when no machine is free. Machines add capacity; they never become a single point of failure.
- **One workflow change.** Opting a job in is a relay job and a `runs-on` change. Everything after that, such as the runner order, pausing and adding machines, happens in the dashboard or CLI with no commits.
- **Public repositories never run on machines.** Anyone could run code on a machine through a pull request, so RelayRunner skips machines for public repositories' jobs.
- **Queue when busy, fail fast otherwise.** When your machines are only busy, the job waits for a free slot, as it would on any self-hosted runner. When nothing can take it, the relay fails with the reason instead of leaving a job queued.
- **Built for people and agents.** The CLI has readable output for people and `--json` for agents, and setup is safe to retry.
