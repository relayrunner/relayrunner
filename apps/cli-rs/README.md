# relayrunner in Rust

A Rust build of the `relayrunner` CLI, which the Mac app bundles in place of the Bun-compiled
TypeScript one: under 3 MB instead of 85 MB, and a few MB of memory while connected. It has every
command: `connect` (with sign-in, runner install and updates, jobs on the machine or in VMs, and
`--events`), `init`, `login`, `whoami`, `pause`, `resume`, `share`, `workspaces` and `firewall`.
Both builds share `~/.relayrunner`, and its version is `apps/cli/package.json`'s.

```sh
cargo test
cargo build --release   # target/release/relayrunner
```

The messages it exchanges with the gateway are checked against
`packages/machine-protocol/fixtures.json`, which the TypeScript tests check too.

`init` edits workflow files line by line rather than reprinting them, so everything it doesn't add
or change stays as written, and it checks that the result reads back as routed before writing it.
