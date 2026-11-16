# RelayRunner for Mac

A menu bar app that takes jobs on your Mac with one switch. It runs the same `relayrunner connect`
as the CLI, compiled into the app, so there's nothing else to install.

The robot head in the menu bar opens a panel where you can turn it on and off, pause new jobs, see
what's running, and open the dashboard. The head is faded while it isn't taking jobs and has a dot
while a job runs. Settings has the same options as `connect`: jobs at once, each VM's CPUs and memory,
macOS jobs, and local network access. Its Workspaces tab picks which workspaces the Mac takes jobs
from and who can run them, like `relayrunner workspaces` and `relayrunner share`. The first time you turn it on, it asks who can run jobs here
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

## Release

Releases run on a Mac, at the CLI's version, once that CLI release is out:

```sh
apps/mac/scripts/release.sh --dry-run   # build, sign and notarize into apps/mac/dist
apps/mac/scripts/release.sh             # and publish
```

It signs every part with the Developer ID certificate in the keychain, notarizes and staples the
app and a DMG, and signs a zip for Sparkle. Publishing uploads the DMG and zip to the `v<version>`
GitHub release, bumps the cask in [relayrunner/homebrew-tap](https://github.com/relayrunner/homebrew-tap)
(`brew install --cask relayrunner/tap/relayrunner`), and opens a PR with the new
`apps/site/public/mac/appcast.xml`. Installed apps check that feed about once a day and offer the
update once the PR merges and the site deploys.

The keychain needs a Developer ID Application certificate, a notarytool profile named
`relayrunner` (`xcrun notarytool store-credentials relayrunner`), and Sparkle's private key. The
key was made once with `generate_keys` from `scripts/setup-sparkle.sh`'s folder; its public half is
`SUPublicEDKey` in `Info.plist`. Losing the private key means existing installs can't update, so
keep a copy (`generate_keys -x <file>` exports it).

## How it works

The app starts `relayrunner connect --events` in its own process group and reads one JSON event
per line from its stdout (see `apps/cli/events.ts`). It sends `pause` and `resume` on stdin and
stops it with SIGINT to the group, as Ctrl-C does in a terminal. What `connect` would print for a
person goes to `~/.relayrunner/app.log`, which Show Log opens.

The robot head is drawn from the same paths as `apps/site/public/assets/runner-head.svg`
(`Sources/RelayRunnerKit/RobotHead.swift`). `Resources/AppIcon.icns` is that head on a cream tile.
