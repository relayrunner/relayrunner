# @relayrunner/mac

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
