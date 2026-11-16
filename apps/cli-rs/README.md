# relayrunner in Rust

A Rust build of the `relayrunner` CLI, which the Mac app bundles in place of the Bun-compiled
TypeScript one: about 2.5 MB instead of 85 MB, and a few MB of memory while connected. It has the
commands the app runs:

- `connect`, with sign-in, runner install and updates, jobs on the machine or in VMs, and
  `--events`
- `workspaces [list [--json] | add <name> | remove <name>]`
- `share only-me|anyone`

The rest (`login`, `whoami`, `init`, `pause`, `resume`, `firewall`, and `share` without an argument)
are still TypeScript only. Both builds share `~/.relayrunner`, and its version is
`apps/cli/package.json`'s.

```sh
cargo test
cargo build --release   # target/release/relayrunner
```

The messages it exchanges with the gateway are checked against
`packages/machine-protocol/fixtures.json`, which the TypeScript tests check too.
