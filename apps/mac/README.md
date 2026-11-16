# RelayRunner for Mac

A menu bar app that takes jobs on your Mac with one switch. It runs the same `relayrunner connect`
as the CLI, compiled into the app, so there's nothing else to install.

The robot head in the menu bar opens a panel where you can turn it on and off, pause new jobs, see
what's running, and open the dashboard. The head is faded while it isn't taking jobs and has a dot
while a job runs. Settings has the same options as `connect`: jobs at once, each VM's CPUs and memory,
macOS jobs, and local network access. The first time you turn it on, it asks who can run jobs here
and opens your browser to sign the Mac in. It shares `~/.relayrunner` with the CLI, so a Mac already
connected with `npx relayrunner connect` is signed in already. Only one of them runs at a time.

## Build

You need Xcode (or its command line tools), Node and Bun on a Mac with Apple silicon.

```sh
apps/mac/scripts/build-app.sh
open apps/mac/dist/RelayRunner.app
```

The build is signed ad hoc, so it runs on the Mac that built it. `swift test` in `apps/mac` runs the
tests. To try changes to the CLI without rebuilding the app, point it at another copy:
`RELAYRUNNER_CLI=/path/to/relayrunner open apps/mac/dist/RelayRunner.app` (or run
`.build/release/RelayRunner` with that variable set).

## How it works

The app starts `relayrunner connect --events` in its own process group and reads one JSON event
per line from its stdout (see `apps/cli/events.ts`). It sends `pause` and `resume` on stdin and
stops it with SIGINT to the group, as Ctrl-C does in a terminal. What `connect` would print for a
person goes to `~/.relayrunner/app.log`, which Show Log opens.

The robot head is drawn from the same paths as `apps/site/public/assets/runner-head.svg`
(`Sources/RelayRunnerKit/RobotHead.swift`). `Resources/AppIcon.icns` is that head on a cream tile.
