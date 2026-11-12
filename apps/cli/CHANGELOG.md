# relayrunner

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
