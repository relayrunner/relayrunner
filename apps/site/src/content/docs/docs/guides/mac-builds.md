---
title: macOS and iOS builds on your Mac
description: Run macOS jobs on a Mac you own, and fall back to hosted Macs when it's busy or asleep.
sidebar:
  label: macOS builds
---

macOS minutes on GitHub cost about ten times Linux minutes, so iOS and Mac builds are often most of a CI bill. A Mac mini or the MacBook you already use can run the same jobs for free.

## 1. Connect the Mac

On the Mac:

```sh
npx relayrunner connect
```

Leave it running. A Mac mini that stays on makes a good dedicated runner; set it to not sleep in System Settings. Don't add `--isolated` by itself here: isolated jobs run on Linux, and these builds need macOS. `--isolated --macos` takes both.

## 2. Route the macOS jobs

```sh
npx relayrunner init
```

`init` gives each `macos-*` job a relay like this:

```yaml
relay-build:
  uses: relayrunner/actions/.github/workflows/relay.yml@v1
  with:
    machine: macOS
    github: macos-latest
```

`machine: macOS` means only Macs take it, never a Linux machine. Use `macOS, ARM64` to require Apple silicon.

## 3. Set the order

Keep **Self-hosted** above **GitHub-hosted** on the Router page. The Mac takes the job when it's free, and a hosted Mac takes it otherwise.

## Things to check

- **Xcode.** The job uses whatever Xcode is installed on the Mac. Select a version in the job, such as with `xcode-select`, rather than relying on the default.
- **Signing.** Keychains and certificates on the Mac are visible to the job. Route signing and release jobs only to a Mac you trust, or keep them on GitHub.
- **Simulators** and caches persist on the Mac between jobs, which makes later runs faster. Clean them up now and then.
- **Several Macs.** Connect each one. Each job goes to an idle one.

## A Mac you don't own

A leased or cloud Mac works the same way: run `relayrunner connect` on it.
