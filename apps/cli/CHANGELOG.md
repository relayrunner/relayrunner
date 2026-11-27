# relayrunner

## 0.23.0

### Minor Changes

- 0426091: `relayrunner eval` is now `relayrunner benchmark`. `eval` still works, so scripts that use it keep running.

## 0.22.0

### Minor Changes

- 3dd8581: Add `relayrunner eval`, which evaluates a hosted provider on one of your workflows from the terminal: five runs from the default branch, compared with the workflow's recent runs. It starts the same evaluation as the dashboard's Evaluate page, so you can follow it in either place. `eval watch`, `eval list` and `eval stop` follow, list and stop evaluations, including ones started in the dashboard.

### Patch Changes

- 6e1b92a: `relayrunner eval` shows the run that's going now, not the last one.

## 0.21.0

### Minor Changes

- 6adaf44: `relayrunner init` now writes what each job needs instead of its old provider's label: `os`, plus `arch` when the label isn't the usual one (such as `ubuntu-24.04-arm` or `macos-13`) and `cpus` when it asks for more than 2 (such as `blacksmith-8vcpu-ubuntu-2404`). Every runner on your Router page can then take the job. `--exact` keeps the old label as before. `--auto` is no longer needed and does nothing. Routed jobs use relay.yml `v1.0.0-beta.10`.

### Patch Changes

- 0a5d76d: `relayrunner init` pins the relay to `relay.yml@v1`, the stable major tag, instead of a beta release, so routed workflows pick up 1.x fixes without edits.

## 0.20.1

### Patch Changes

- 9f2b67d: `relayrunner blacksmith connect` reads which organization Blacksmith made the token for again, so it connects the workspace on that organization without asking. When it still has to ask, the list starts on the workspace named like the organization.

## 0.20.0

### Minor Changes

- ad9d8a3: `relayrunner feedback "…"` sends a message to the RelayRunner team with your name and email, so we can reply, or without them with `--anonymous`. `--file` sends a file's text and `--category` marks it as a bug, something confusing or a feature request.

## 0.19.1

### Patch Changes

- 91d2368: `init` now points to the agent skills after it routes jobs.
- 4b71127: `relayrunner jobs --help` lists the `--since`, `--repo`, `--workflow` and `--result` filters.

## 0.19.0

### Minor Changes

- 3dcc656: `relayrunner init` recognises Groundbox labels (`groundbox-4vcpu` and the like), keeps them as a job's fallback, and writes relays pinned to `relay.yml@v1.0.0-beta.9`, which takes a `groundbox` input.

## 0.18.0

### Minor Changes

- 5fc4652: `relayrunner blacksmith connect` connects your Blacksmith organization so Settings › Providers shows its real usage. You approve an org token in your browser as a Blacksmith org admin, and only that token is sent to RelayRunner. If Blacksmith's CLI isn't installed, it offers to download it into `~/.relayrunner/bin`.
- 1f04e85: `relayrunner init` no longer skips a job just because it can request OIDC tokens (`id-token: write`), such as for a Turbo or Vercel remote cache. It's still a deploy job when it uses the token to sign in to a cloud or publish a package; otherwise it's ready, with a warning. `--allow-deploy <jobs>` routes jobs that look like deploy jobs, once you're fine giving the machine their secrets.

## 0.17.0

### Minor Changes

- 506809e: `relayrunner init --auto` writes `auto` in place of a Linux x64 job's runner label, so you set the job's size on the dashboard's Router page instead of in the workflow file. macOS and Arm jobs keep their labels.

## 0.16.0

### Minor Changes

- 4cdfc46: The Mac Jobs window opens with the jobs it last showed and refreshes them in the background, and a job you've already opened shows its steps at once. Jobs running or waiting on the Mac come first. Filter by result, repo, workflow and time, and drag the line between the list and the job to resize them. Clicking a job in the menu's History tab opens it in the Jobs window. `relayrunner jobs` lists running jobs first and gains `--repo`, `--workflow`, `--result` and `--since`.

## 0.15.0

### Minor Changes

- 953162e: `relayrunner init` recognises Lizard labels (`lizard-medium-ubuntu-2404` and the like), keeps them as a job's fallback, and writes relays pinned to `relay.yml@v1.0.0-beta.8`, which takes a `lizard` input.
- baf94e7: RelayRunner for Mac has a Jobs window (Jobs… in the menu, ⌘J while it's open). It lists every job the Mac ran in the last week, sortable by how long each waited and ran. Pick one to see its steps on a timeline and, for a failed job, the step that failed, GitHub's annotations, the end of its log and, when the workspace has AI on, the likely cause. The CLI gains `relayrunner jobs` and `relayrunner jobs <id>`, which read the same from the gateway with the machine's own token.

## 0.14.0

### Minor Changes

- 0604547: `connect` keeps a history of the jobs it runs in `~/.relayrunner/history.jsonl`, and `relayrunner history` lists them with each one's result and time. When it starts a job it now names it, and with `--events` the `run` event says which job it is and how long it usually takes on this machine.
- d711d03: `relayrunner init` recognises StarSling, Monk CI, Runloft, Latchkey, BerryBox, Celesto and InstaBox labels, keeps them as a job's fallback, and writes relays pinned to `relay.yml@v1.0.0-beta.7`, which takes an input for each.
- 343bf9d: The Mac menu and `connect --events` now say how many jobs are waiting for a slot on this machine.

### Patch Changes

- 0289780: The Mac menu's Queue names each waiting job and its workflow once GitHub has said which job it is. When jobs went to hosted runners because every slot was busy, a button allows one more job at once: the app pauses new jobs, waits for the running ones to finish, and comes back with the extra slot, or goes back to the earlier setting if it can't.
- c8a45d2: The Mac menu has Now, Queue and History tabs. Queue lists the jobs waiting for this Mac and how long each has waited, and says when jobs went to hosted runners in the last hour because every slot was busy. History shows the last 12 hours as a bar per hour, with the latest jobs, all or only failed. `connect --events` adds `queue` and `spilled` to `waiting` and `state`.
- 3d61813: The Mac menu shows a row for each job slot, free ones included, with a bar against each job's usual time, and this Mac's CPU and memory while the menu is open. `connect --events` says how many slots the machine has in `state`.
- 7ac67e0: New installs connect to https://app.relayrunner.dev and link to relayrunner.dev. Machines already connected keep their saved server, https://app.relayrunner.app, which keeps working.

## 0.13.2

### Patch Changes

- 385cc15: `connect --events` reports each job's result, so the Mac app can tell you when a job fails.

## 0.13.1

### Patch Changes

- 310290e: The Runners page shows when a machine runs through the Mac app, with the app's version beside its CLI's.

## 0.13.0

### Minor Changes

- 72b7e65: `relayrunner` is now a native binary rather than a Node.js program, so it's a smaller download and starts faster. npm installs the one for your computer, and the commands are the same.

## 0.12.0

### Minor Changes

- a3adbb5: `relayrunner init` recognises Boat labels (`boat`, `boat-large` and the like), keeps them as a job's fallback, and writes relays pinned to `relay.yml@v1.0.0-beta.6`, which takes a `boat` input.
- cc9f37e: `connect --events` writes JSON events to stdout and takes `pause` or `resume` on stdin, for apps that run `connect`. Only one `connect` runs on a computer at a time now.

### Patch Changes

- 70a5aab: `relayrunner workspaces list --json` includes each workspace's logo.

## 0.11.0

### Minor Changes

- 3b7fd59: `connect` now keeps GitHub's runner up to date while it stays open. Every 6 hours it checks for a newer release and switches to it between jobs, so a job that's running finishes on the runner it started with. Before, a machine left connected for weeks fell behind until GitHub stopped sending it jobs.

## 0.10.1

### Patch Changes

- c088700: When the gateway refuses a request, `pause`, `share`, `whoami` and `workspaces` now show its reason and error code, such as "Only a machine with an owner can do this (MACHINE_NOT_OWNED)", instead of only the HTTP status.

## 0.10.0

### Minor Changes

- 68da6cf: Report how much CPU and memory each job uses. The dashboard's History page shows it for jobs on your machine.

## 0.9.2

### Patch Changes

- 5a6c90a: `relayrunner connect` now tells the dashboard how many CPUs and how much memory each job VM gets, so the Runners and Performance pages can show it.

## 0.9.1

### Patch Changes

- c800ba7: `relayrunner connect` now checks that its Linux VMs can look up hostnames before it builds the job image. When they can't, often because of VPN or DNS filtering software that's still running when its app is closed, it says so and how to check, instead of failing to build the image.

## 0.9.0

### Minor Changes

- 4cb5574: `relayrunner firewall on` adds a firewall on your Mac for isolated jobs. Job VMs can reach the internet, not your Mac or your local network, and no job can remove it, even with Docker. It asks for your password, stays on after a restart, and `relayrunner firewall off` removes it.
- 9249a08: On a Mac with Apple silicon and Apple's container tool, `connect` now runs each job in its own Linux VM, away from your files. `--macos` also takes macOS jobs on the Mac itself, and `--no-isolated` runs every job there. Without the container tool, jobs run on the Mac and `connect` says how to set it up.

  New `--cpus` and `--memory` flags set the size of each job's VM, like a hosted runner's size. With a size and no `--concurrency`, as many jobs run at once as fit.

- d074fdf: `relayrunner connect --isolated --macos` takes both kinds of job on one Mac. Linux jobs run in a VM, and macOS jobs such as Xcode builds run on the Mac itself.
- 4ba2184: Isolated jobs now find the everyday tools a job written for `ubuntu-latest` expects: Node with npm, pip, compilers and `make`, `wget`, `zip`, Git LFS, Docker Compose and the `gh` CLI. An image given with `--image` is used as it is.

### Patch Changes

- d25ac96: License the CLI under Apache 2.0 and ship the LICENSE file in the npm package.
- 7dc2e01: `connect` says where jobs run when it starts, and how to take macOS jobs too. With `--macos` or `--no-isolated` it warns that those jobs can read your files.
- d831af0: `init` no longer warns about Docker or Linux packages on a Mac that runs jobs in a VM.

## 0.8.0

### Minor Changes

- f264630: Docker works in isolated jobs. `relayrunner connect --isolated` now starts Docker inside each job's VM, so jobs with `services:`, `container:` or `docker build` run. `--local-network` uses the same job image as the default, so it builds that image once too.
- 01a82da: `relayrunner connect --isolated` (experimental) runs each job in its own Linux VM on a Mac with Apple silicon, using Apple's `container` tool. The VM starts from GitHub's runner image with none of your files mounted, can reach the internet but not your Mac or local network, and is deleted when the job ends. `--local-network` lets jobs reach your network, and `--image` starts from another runner image. `connect` removes the images it got for older runner versions, and keeps a log of what it did in `~/.relayrunner/isolated.log`.
- 3086648: `relayrunner workspaces` shows which of your workspaces this machine runs jobs in and which it doesn't, with its sharing. `relayrunner workspaces add <name>` and `remove <name>` change that, by workspace name, slug or id, or from a list when you leave the name out. Adding a workspace while the machine runs anyone's jobs warns that anyone who can push to that workspace's private repos can run jobs on it. After you approve a new machine, `connect` prints the workspaces it runs jobs in and how to change them, and `connect` and `whoami` tell a machine that isn't in any of your workspaces apart from an account with no workspace yet.

### Patch Changes

- 0f8a28a: `relayrunner connect` suggests `--isolated` on Macs that can use it.
- 79a2d06: After its connection drops, `relayrunner connect` waits a few random seconds before reconnecting, so machines don't all reconnect at the same moment after a RelayRunner update.

## 0.7.0

### Minor Changes

- c5a840b: `relayrunner connect` tells you when npm has a newer `relayrunner`, with the command that updates it (`npx relayrunner@latest connect`, or `npm install --global relayrunner@latest` for a global install). It asks npm at most once a day, in the background, so it never slows down connecting, and a `connect` left running checks again each day. It only checks when someone is at the terminal and not in CI. `connect` also tells the gateway which CLI version the machine runs, and `relayrunner --version` prints it.
- ba39692: `relayrunner connect` runs several jobs at once: 2 on a computer with 8 or more CPU cores, otherwise 1. `--concurrency <n>` changes it. Each slot runs its jobs in its own copy of the runner (`~/.relayrunner/runner/<version>/slot-<n>/`), and with more than one slot each line of a job's output starts with its slot.

## 0.6.0

### Minor Changes

- 6443e9e: A machine is now in every workspace you're a member of, so signing in no longer means picking one. `relayrunner connect` and `login` print the workspaces the machine is in, and `whoami` lists them. The sharing question shows when any of your workspaces has someone else in it, and `anyone` means any job in your workspaces. If you aren't in a workspace yet, signing in still works: the CLI says so and links to the GitHub install, and the machine takes jobs once you're in one. `~/.relayrunner/machine.json` no longer saves a workspace, and files from earlier versions still load.
- cb0dd7a: `relayrunner init` keeps a job's Depot, Namespace, WarpBuild, Ubicloud or RunsOn label as its fallback, the same way it keeps a Blacksmith label.

## 0.5.0

### Minor Changes

- 0e7ab11: `relayrunner connect` now names its terminal tab after the machine and what it's doing, such as "RelayRunner · M3P0 · Waiting for jobs", "Running a job" or "Paused", and puts the old title back when it exits. Press `p` to pause or resume the machine without disconnecting, the same as pausing it on the Runners page.

### Patch Changes

- 83edb50: On a Mac without a hostname of its own, the suggested machine name is now the Computer Name from System Settings (such as "Zach's MacBook Pro") instead of a generic one like `Mac.local`. A hostname you set still comes first. The download message also says that `actions/runner` is GitHub's official runner.

## 0.4.0

### Minor Changes

- 90b736f: `relayrunner connect` gets a new machine token from the gateway each time it comes online and the old one stops working, so a copied `machine.json` can't sign in as the machine for long. If another copy does sign in while this one is online, the person who approved the machine gets an email.

  Before it runs a job, `connect` checks the job's runner config: only GitHub's files, only GitHub servers over https, and a runner named for that job. Anything else is refused and reported as a failed job. The terminal now shows which repo each job is from.

  `--server`, `RELAYRUNNER_URL` and saved sign-ins must use https, except for `localhost` while developing.

  The sharing prompt now says that "Anyone in the workspace" only covers jobs from repos you can open.
