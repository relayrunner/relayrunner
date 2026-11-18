# RelayRunner for Mac

A menu bar app that takes jobs on your Mac with one switch. It runs `relayrunner connect` from the
Rust build of the CLI (`apps/cli`), which is inside the app, so there's nothing else to install.

The robot head in the menu bar opens a panel where you can turn it on and off, pause new jobs, see
what's running, and open the dashboard. The head is faded while it isn't taking jobs and has a dot
while a job runs. Settings has the same options as `connect`: jobs at once, each VM's CPUs and memory,
macOS jobs, and local network access. Its Workspaces tab picks which workspaces the Mac takes jobs
from and who can run them, like `relayrunner workspaces` and `relayrunner share`. The first time you turn it on, it asks who can run jobs here
and opens your browser to sign the Mac in. It shares `~/.relayrunner` with the CLI, so a Mac already
connected with `npx relayrunner connect` is signed in already. Only one of them runs at a time.

## Build

You need Xcode (or its command line tools), Node and Rust ([rustup](https://rustup.rs)) on a Mac
with Apple silicon.

```sh
apps/mac/scripts/build-app.sh
open apps/mac/dist/RelayRunner.app
```

The build is signed ad hoc, so it runs on the Mac that built it. `swift test` in `apps/mac` runs the
tests. To try changes to the CLI without rebuilding the app, point it at another copy:
`RELAYRUNNER_CLI=/path/to/relayrunner open apps/mac/dist/RelayRunner.app` (or run
`.build/release/RelayRunner` with that variable set).

## Release

The app has its own version, in `package.json`. A PR that changes the app adds a changeset naming
`"@relayrunner/mac"`, and the `chore: version packages` PR bumps it. CI can't release the app,
because it has to be signed with the Developer ID certificate. After the version PR merges, release
from main on any Mac with access to that certificate and the rest of the signing setup below (see
[Before you publish](#before-you-publish)):

```sh
pnpm release:mac:dry-run   # build, sign and notarize
pnpm release:mac           # and publish
```

Both run from a clean worktree of the latest `origin/main` at `../relayrunner-release` (set
`RELAYRUNNER_RELEASE_WORKTREE` to use another folder), so your own checkout stays as it is. The
first run creates the worktree; later runs move it to the latest `origin/main` and install
dependencies before calling `apps/mac/scripts/release.sh`, which you can also run directly from
any clean checkout of main. A dry run leaves the DMG and zip in the worktree's `apps/mac/dist`.

It signs every part with the Developer ID certificate in the keychain, notarizes and staples the
app and a DMG, and signs a zip for Sparkle. It bundles the CLI from the same commit, whose version
the About tab shows. Publishing makes a `mac-v<version>` GitHub release with the DMG and zip, bumps the cask in [relayrunner/homebrew-tap](https://github.com/relayrunner/homebrew-tap)
(`brew install --cask relayrunner/tap/relayrunner`), and opens a PR with the new
`apps/site/public/mac/appcast.xml`. Installed apps check that feed about once a day and offer the
update once the PR merges and the site deploys. The update window shows that version's
`CHANGELOG.md` section, which the appcast carries inline as Markdown.

The keychain needs a Developer ID Application certificate, a notarytool profile named
`relayrunner` (`xcrun notarytool store-credentials relayrunner`), and Sparkle's private key. The
key was made once with `generate_keys` from `scripts/setup-sparkle.sh`'s folder; its public half is
`SUPublicEDKey` in `Info.plist`. Losing the private key means existing installs can't update, so
keep a copy (`generate_keys -x <file>` exports it).

### Before you publish

- Install the tools from [Build](#build). The script commits the appcast, and the pre-commit hook
  runs the typecheck, which needs the repo's dependencies. The pnpm tasks install them; if you run
  `release.sh` directly, run `pnpm install` first.
- Sign in to `gh` as someone who can push to this repo and to
  [relayrunner/homebrew-tap](https://github.com/relayrunner/homebrew-tap). The script pushes the cask
  straight to the tap's default branch.
- Release from a clean checkout of a commit on main. The script stops if either isn't true. It
  leaves the checkout on a new `release/mac-v<version>` branch, which is why the pnpm tasks use a
  separate worktree.

A release takes a few minutes. Most of that is the build and the two notarizations, which Apple
usually finishes in under a minute each. The first time `codesign` or Sparkle's `sign_update` reads
a key, macOS may ask to allow keychain access. Choose Always Allow so later releases run without the
prompt.

The script doesn't mark the GitHub release as latest, so the CLI's release stays the one GitHub
shows first. After it finishes, review and merge the appcast PR. If you run the script through a
coding agent, the agent needs your approval to publish, because the release, the cask and the PR
are public.

## How it works

The app starts `relayrunner connect --events` in its own process group and reads one JSON event
per line from its stdout (see `apps/cli/src/events.rs`). It sends `pause` and `resume` on stdin and
stops it with SIGINT to the group, as Ctrl-C does in a terminal. What `connect` would print for a
person goes to `~/.relayrunner/app.log`, which Show Log opens.

The robot head is drawn from the same paths as `apps/site/public/assets/runner-head.svg`
(`Sources/RelayRunnerKit/RobotHead.swift`). `Resources/AppIcon.icns` is that head on a cream tile.
