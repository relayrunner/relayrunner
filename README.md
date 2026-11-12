# RelayRunner

RelayRunner routes GitHub Actions jobs across the runners you already have. Each job goes to the first runner in your workspace's runner order that can take it right now: one of your own machines when it's online and free, an existing self-hosted runner, a hosted provider such as Blacksmith or Depot, or GitHub's hosted runners. Developers keep their usual push workflow and see the same checks and logs in GitHub.

It's built for small teams and individuals who don't want to pay for every push, and for any team whose CI usage spikes. Your laptops and other machines take jobs while they're online, and hosted runners take the rest, with no switch to flip.

[PRODUCT.md](PRODUCT.md) describes the product in full: how routing works, the runner providers, and the principles behind them.

## How it works

1. **Install the GitHub App** on an organization or personal account. Each install is its own RelayRunner workspace, and everyone who can see the install on GitHub is a member.
2. **Connect a machine** with `npx relayrunner connect`. While it runs, the machine takes jobs; Ctrl-C takes it offline.
3. **Opt a job in** by adding a relay job in front of it and pointing its `runs-on` at the relay's answer:

   ```yaml
   jobs:
     relay-test:
       uses: relayrunner/actions/.github/workflows/relay.yml@v1
       with:
         machine: self-hosted # any connected machine
         github: ubuntu-latest # used when no machine is free

     test:
       needs: relay-test
       runs-on: ${{ needs.relay-test.outputs.runner }}
       steps:
         - uses: actions/checkout@v4
         - run: npm test
   ```

   RelayRunner answers the relay itself in about a second, so it bills no minutes. If nothing fits, the relay fails with the reason instead of leaving the job queued.

The relay workflow and the optimized checks live in [relayrunner/actions](https://github.com/relayrunner/actions). [docs/agent-install.md](docs/agent-install.md) walks a coding agent through the whole setup, including which jobs are a good fit.

Public repositories never run on connected machines, since anyone could run code there through a pull request.

## Repository layout

This is a pnpm workspace. The apps are deployed as Cloudflare Workers, except the CLI, which is published to npm.

| App                              | What it is                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| [`apps/api`](apps/api)           | The gateway: auth, workspaces, routing, the webhook queue consumer and the Durable Objects. |
| [`apps/web`](apps/web)           | The dashboard, a React SPA that reaches the API over a service binding.                     |
| [`apps/webhooks`](apps/webhooks) | Verifies GitHub webhook deliveries and queues them for the API.                             |
| [`apps/agents`](apps/agents)     | The MCP server agents connect to, read-only, at agents.relayrunner.app/mcp.                 |
| [`apps/cli`](apps/cli)           | The `relayrunner` CLI that connects a machine to a workspace.                               |
| [`apps/site`](apps/site)         | The public site at [relayrunner.app](https://relayrunner.app): landing page and docs.       |

| Package                                                  | What it is                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`packages/access`](packages/access)                     | Cloudflare Access JWT checks and the gate for operator `/admin` views. |
| [`packages/activity`](packages/activity)                 | Activity log event schemas and feed types shared by the API and web.   |
| [`packages/email`](packages/email)                       | Transactional email templates.                                         |
| [`packages/github-webhooks`](packages/github-webhooks)   | Webhook signature checks and the compact queue message format.         |
| [`packages/lint-runner`](packages/lint-runner)           | The lint container image and its protocol with the API.                |
| [`packages/machine-protocol`](packages/machine-protocol) | Messages between a connected machine and the gateway.                  |
| [`packages/runner-order`](packages/runner-order)         | The runner order schema, defaults and labels.                          |

Each app and package has its own README. Longer write-ups live in [`docs/`](docs): [Cloudflare Access](docs/cloudflare-access.md), the [GitHub App](docs/github-app.md) and the [pick runner](docs/architecture/pick-runner.md).

## Development

Use the Node.js version in `.nvmrc` (24.x) and pnpm 11 (pinned by `packageManager`, so Corepack picks it up). Then, from the repository root:

```sh
pnpm install
pnpm check
```

`pnpm check` runs everything CI runs:

- `pnpm lint` runs Oxlint.
- `pnpm format` formats with oxfmt; `pnpm format:check` verifies it.
- `pnpm typecheck` checks types without emitting JavaScript.
- `pnpm test` runs the Vitest suite once; `pnpm test:watch` reruns affected tests as files change.

Write code in TypeScript and put tests next to the code they cover, as `*.test.ts` or `*.test.mts`. `pnpm install` sets up a Husky pre-commit hook that runs Oxlint and oxfmt on staged files and then type checks. In VS Code or Cursor, install the recommended Oxc extension to format on save.

To run the stack locally, start the API and the dashboard (see [`apps/api`](apps/api#run-it-locally) and [`apps/web`](apps/web#develop)).

### Environment files

Each place that reads local settings has an example to copy. The copies are gitignored.

| Example                                                    | Copy to     | For                                                                         |
| ---------------------------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| [`.env.example`](.env.example)                             | `.env`      | Cloudflare API credentials and the Access service token for admin commands. |
| [`apps/api/.dev.vars.example`](apps/api/.dev.vars.example) | `.dev.vars` | The API's local secrets: Better Auth and the GitHub App's OAuth client.     |
| [`apps/web/.env.example`](apps/web/.env.example)           | `.env`      | Where the dashboard's dev server proxies `/api`.                            |

The webhooks Worker has none: its secrets live in the Secrets Store (see [`apps/webhooks`](apps/webhooks#run-it-locally)). The CLI reads `RELAYRUNNER_URL` and `RELAYRUNNER_HOME` from the shell (see [`apps/cli`](apps/cli)).

## Contributing

Commit messages and pull request titles use [Conventional Commits](https://www.conventionalcommits.org/), such as `feat(api): add runner order rules`. [AGENTS.md](AGENTS.md) has the full conventions, which apply to people and coding agents alike.
