# relayrunner CLI

The `relayrunner` CLI, in Rust. npm ships it as `relayrunner` (a small launcher in `apps/cli`) plus
one `@relayrunner/cli-<os>-<cpu>` package per platform, and the Mac app bundles it. It has every
command: `connect` (with sign-in, runner install and updates, jobs on the machine or in VMs, and
`--events`), `init`, `login`, `whoami`, `pause`, `resume`, `share`, `workspaces` and `firewall`.
Its version is `apps/cli/package.json`'s.

```sh
cargo test
cargo build --release   # target/release/relayrunner
cargo run -- --help     # or `pnpm relayrunner --help` from the repo root
```

The messages it exchanges with the gateway are checked against
`packages/machine-protocol/fixtures.json`, which the protocol package's tests check too.

`init` edits workflow files line by line rather than reprinting them, so everything it doesn't add
or change stays as written, and it checks that the result reads back as routed before writing it.
