# RelayRunner CLI

Connects a machine to the RelayRunner gateway so it can run your workspace's
GitHub Actions jobs. It's published to npm as
[`relayrunner`](https://www.npmjs.com/package/relayrunner) and needs Node.js 22
or newer on macOS or Linux (x64 or ARM64).

```sh
npm install --global relayrunner   # or use npx relayrunner
```

Machines only take jobs from private repositories. To opt jobs in, see the
[root README](../../README.md#how-it-works) or
[docs/agent-install.md](../../docs/agent-install.md).

## `relayrunner connect`

```sh
npx relayrunner connect
```

The first run signs you in: it shows a code and opens the dashboard, where you
pick the workspace and name for this machine and approve. The machine token is
saved to `~/.relayrunner/machine.json` (mode 0600); later runs reuse it.

While it runs, the machine is online: it keeps a WebSocket open to the gateway,
runs the jobs it's sent (one at a time) and prints what happens. It reconnects
on its own if the connection drops. Ctrl-C takes it offline; a job that's
running stops with it.

- `--server <url>` or `RELAYRUNNER_URL` points it at another gateway. Changing it signs in again.
- `--name <name>` changes the suggested machine name (default: the hostname).
- If the machine is removed in the dashboard, `connect` deletes the saved token.
  A running `connect` exits and asks you to run it again; a new one signs in
  straight away.

Jobs run in `actions/runner`, which is downloaded into
`~/.relayrunner/runner/<version>` on first connect and checked against its
SHA-256. Set `RELAYRUNNER_HOME` to keep everything somewhere else.

## `relayrunner whoami`

```sh
npx relayrunner whoami
```

Asks the gateway who the saved machine token belongs to and prints the machine,
its workspace, who enrolled it (name and email) and whether it's online now.

- Not signed in: says so and exits 1.
- Removed from the workspace (or the token is no longer valid): says so and
  exits 1. The saved token is left alone; the next `connect` replaces it.
- Gateway unreachable: prints what's saved locally, marked unverified, and exits 0.
- `--json` prints the same as JSON (never the token). `--server <url>` or
  `RELAYRUNNER_URL` only reports a sign-in for that gateway.

## `relayrunner pause` and `relayrunner resume`

```sh
npx relayrunner pause
npx relayrunner resume
```

Pausing stops new jobs routing to this machine while it stays connected and
enrolled. A job it's already running finishes. `resume` lets jobs route here
again. Anyone in the workspace can do the same from the machine's ⋯ menu on the
Runners page, and a running `relayrunner connect` prints when that happens.
Both exit 1 when not signed in or when the token is no longer valid.

## Building

`pnpm --filter relayrunner build` bundles the CLI into `dist/cli.js` with
tsdown, including the workspace's `@relayrunner/machine-protocol` package.
