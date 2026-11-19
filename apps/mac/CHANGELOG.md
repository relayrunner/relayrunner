# @relayrunner/mac

## 0.6.0

### Minor Changes

- 4cdfc46: The Mac Jobs window opens with the jobs it last showed and refreshes them in the background, and a job you've already opened shows its steps at once. Jobs running or waiting on the Mac come first. Filter by result, repo, workflow and time, and drag the line between the list and the job to resize them. Clicking a job in the menu's History tab opens it in the Jobs window. `relayrunner jobs` lists running jobs first and gains `--repo`, `--workflow`, `--result` and `--since`.
- 714033a: A simpler menu. It shows the switch, what this Mac is doing and each running job, then Pause New Jobs, Jobs, Open Dashboard, Settings and Quit, with no icons. The Now, Queue and History tabs, the empty slot rows and the CPU and memory meters are gone: the Jobs window lists running, waiting and finished jobs. There is one pause control, which becomes Resume New Jobs while paused. The offer to take one more job at once moved to the Jobs window. Show Log and Check for Updates moved to Settings › About.

### Patch Changes

- 871649d: The menu no longer shows a running job's usual time once it passes it. The bar turns orange only when the job is clearly slower than usual: at least 30 seconds and a quarter over its usual time.

## 0.5.0

### Minor Changes

- baf94e7: RelayRunner for Mac has a Jobs window (Jobs… in the menu, ⌘J while it's open). It lists every job the Mac ran in the last week, sortable by how long each waited and ran. Pick one to see its steps on a timeline and, for a failed job, the step that failed, GitHub's annotations, the end of its log and, when the workspace has AI on, the likely cause. The CLI gains `relayrunner jobs` and `relayrunner jobs <id>`, which read the same from the gateway with the machine's own token.

## 0.4.0

### Minor Changes

- 0289780: The Mac menu's Queue names each waiting job and its workflow once GitHub has said which job it is. When jobs went to hosted runners because every slot was busy, a button allows one more job at once: the app pauses new jobs, waits for the running ones to finish, and comes back with the extra slot, or goes back to the earlier setting if it can't.
- c8a45d2: The Mac menu has Now, Queue and History tabs. Queue lists the jobs waiting for this Mac and how long each has waited, and says when jobs went to hosted runners in the last hour because every slot was busy. History shows the last 12 hours as a bar per hour, with the latest jobs, all or only failed. `connect --events` adds `queue` and `spilled` to `waiting` and `state`.
- 0604547: The menu shows how long each running job has taken and about how long it has left, based on its usual time on this Mac. It also lists the last five jobs this Mac ran, with a link to each on GitHub and a total for the day, and lets you pause new jobs for an hour, four hours or until tomorrow morning.
- 3d61813: The Mac menu shows a row for each job slot, free ones included, with a bar against each job's usual time, and this Mac's CPU and memory while the menu is open. `connect --events` says how many slots the machine has in `state`.
- 343bf9d: The Mac menu and `connect --events` now say how many jobs are waiting for a slot on this machine.

### Patch Changes

- 7ac67e0: New installs connect to https://app.relayrunner.dev and link to relayrunner.dev. Machines already connected keep their saved server, https://app.relayrunner.app, which keeps working.

## 0.3.1

### Patch Changes

- a096718: The menu bar menu is now a real macOS menu, so it has the system's shape and look.
- 10ba127: The menu bar panel closes when you pick Settings or another item, and Settings stays in front while you use the menu bar.

## 0.3.0

### Minor Changes

- 385cc15: A welcome window on first launch moves the app to Applications, signs your Mac in and turns on opening at login. You can also turn on a notification for when a job fails on your Mac (off by default).
- 71b8060: Quitting while a job runs asks first. You can quit once the job is done, quit now, or cancel.

## 0.2.1

### Patch Changes

- 310290e: The Runners page shows when a machine runs through the Mac app, with the app's version beside its CLI's.

## 0.2.0

### Minor Changes

- 962bac3: The app now bundles a Rust build of the CLI, which takes it from about 89 MB to about 6 MB and uses a few MB of memory while connected.
