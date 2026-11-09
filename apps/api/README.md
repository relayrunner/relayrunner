# RelayRunner API

The gateway backend: a [Hono](https://hono.dev) app on a Cloudflare Worker (`relayrunner-api`), with D1 for storage and Durable Objects for anything long-lived. It serves everything under `/api`. The browser never calls it directly: the dashboard Worker (`apps/web`) forwards `/api/*` here over a service binding, so the two share one origin.

It does four jobs:

- **Accounts and workspaces**: sign-in, workspaces, members and GitHub App installations.
- **Routing**: answering each relay job with the runner its job should use, and handing jobs to connected machines.
- **Free checks**: the PR title check, lint, and checks answered without a runner.
- **Reporting**: the activity log, workflow runs, job timings and Actions usage behind the dashboard.

## Routes

| Prefix              | What it serves                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`   | Liveness check. Touches neither auth nor D1.                                                                                        |
| `/api/auth/*`       | [Better Auth](https://www.better-auth.com), with the GitHub App as its GitHub provider, and its organization plugin for workspaces. |
| `/api/me`           | The signed-in user, or `401`.                                                                                                       |
| `/api/workspaces/*` | The active workspace, its machine counts and its runner order.                                                                      |
| `/api/invites/*`    | Workspace invitations.                                                                                                              |
| `/api/github/*`     | Installing the GitHub App, its Setup URL, and claiming installations made straight from GitHub.                                     |
| `/api/machines/*`   | Machine enrollment (`relayrunner connect`), the machine WebSocket, pause and resume, and adding existing org runners.               |
| `/api/activity`     | The activity log and its filter options.                                                                                            |
| `/api/runs`         | Workflow runs and their jobs.                                                                                                       |
| `/api/job-times`    | Job durations by run and by machine.                                                                                                |
| `/api/usage/*`      | Free-check savings, short jobs, and Actions minutes from GitHub billing.                                                            |
| `/api/admin/*`      | Operator views (users, workspaces, webhook dead letters), behind Cloudflare Access.                                                 |

Routes that act on a workspace check the session's active workspace and the user's role in it. The route files live in `src/routes/`.

## Webhooks

GitHub webhooks don't come in over HTTP here. [`apps/webhooks`](../webhooks) verifies each delivery and puts it on the `relayrunner-github-webhooks` queue, and this Worker's `queue()` handler processes it (`src/webhook-queue.ts`). Delivery is at least once and unordered, so every handler is idempotent.

Failures retry with backoff for about half an hour, then move to `relayrunner-github-webhooks-dlq`, whose consumer archives the message to the R2 bucket `relayrunner-webhook-dead-letters` and acks it only once that write succeeds (`src/dead-letters.ts`). The Access-gated `/api/admin/webhooks/*` routes list, replay and discard them, and an hourly cron emails operators when they pile up (see [docs/cloudflare-access.md](../../docs/cloudflare-access.md#webhook-dead-letters)).

- `installation` and `installation_repositories` keep `github_installation` current: account, suspension and repository selection; `deleted` removes the row and its repos. They and `repository` events also keep `github_repository` current, so activity can be labeled by repo (`src/repositories.ts`).
- `workflow_job` drives routing (below), and every finished job's timing goes to the usage report (`src/job-timings.ts`).
- `workflow_run` records each run's title, trigger and status for the Runs page.
- `pull_request` and `check_suite` start the PR title and lint checks.

## Routing

There's no repo opt-in: a job with `runs-on: relayrunner` from a connected installation is the opt-in. Users add it with the relay reusable workflow from [relayrunner/actions](https://github.com/relayrunner/actions); this code calls that job the pick. `src/routing.ts` describes the flow, and [docs/architecture/pick-runner.md](../../docs/architecture/pick-runner.md) covers the pick runner in depth.

1. On `queued`, the consumer wakes a `PickRunner` Durable Object keyed by job id. It mints a one-job (JIT) runner in the job's org with the App's installation token and claims the pick through GitHub's runner protocol (`src/runner-protocol.ts`). A runner that gets no job within four minutes is deleted.
2. The `PickRunner` asks the workspace's `Router`, which walks the workspace's runner order (`decideRoute`). A machine step reserves a machine and answers a one-time label `rr-<route id>`; a `github` or `blacksmith` step answers the job's own label for that provider. When nothing fits, the pick fails with the reason. Either way the walk is recorded in the activity log.
3. The workflow's next job runs on that label. When its `queued` webhook arrives, the route is claimed and the machine's `MachineLink` Durable Object, which holds the machine's WebSocket, mints a JIT runner on the label and sends the machine a `run` message.

Machines never take a public repo's jobs. The App needs the org permission "Self-hosted runners: Read & write". Pick runners join the org's Default runner group, which has to allow public repositories for public repos.

## Free checks

Two checks need no VM. A pick job whose only steps are `relayrunner/actions/checks/*` is answered by the `PickRunner` itself (`src/native-checks.ts`). That needs a runner group open to the repo, so public repos use the App's check run instead: on `pull_request` opened, reopened, synchronize or a title edit, repos whose `relayrunner.yml` (in `.github/` or the root, on the default branch) sets `checks: pr-title: true` get a **PR title** check run that passes a Conventional Commit title (`src/pr-title-check.ts`, `src/repo-config.ts`). An invalid `relayrunner.yml` fails the check with the reason. It needs the App permissions "Checks: Read & write", "Pull requests: Read" and single-file "Contents: Read" on `relayrunner.yml` and `.github/relayrunner.yml`, and the Pull request event.

### Lint

Lint runs through a second, opt-in GitHub App, **RelayRunner Checks** (App ID in `GITHUB_CHECKS_APP_ID`, key in the Secrets Store as `GITHUB_CHECKS_APP_PRIVATE_KEY`; permissions Contents: Read, Checks: Read & write, Pull requests: Read; events Pull request and Check suite). Its webhooks arrive tagged `app: "checks"` from `/api/webhooks/github-checks`. Installing it does nothing until a repo asks for lint, in one of two ways:

- **`relayrunner.yml`**: `checks: lint: [oxlint, typos]`, or `{ tools, paths }` to scope it. On pull request opened, reopened or synchronize, and on "Re-run all checks" (check_suite rerequested), the consumer wakes a `LintRunner` Durable Object keyed by `repo@sha` (`src/lint-check.ts`, `src/durable-objects/lint-runner.ts`).
- **A native job**: a `runs-on: relayrunner` job whose step is `relayrunner/actions/checks/lint@v1` with a `tools` input (and optional `paths`). The `PickRunner` hands it to a `LintRunner` keyed by `job:<id>`, which lints the job's commit (the PR head, else `github.sha`) with the job's own tools, ignoring `relayrunner.yml`, and completes the job as passed or failed. Put it in a `workflow_dispatch` workflow to lint a branch on demand from the Actions tab. A repo without the Checks App fails the job with a message to install it.

Either way, the `LintRunner` opens a `Lint / <tool>` check run per tool, boots the lint container ([`packages/lint-runner`](../../packages/lint-runner), `standard-1`, no internet access), streams the commit's tarball into it, and finishes each run with its tool's problems as annotations (the first 50). actionlint reads the repo's `.github/actionlint.yaml` (passed explicitly, since a tarball has no `.git`); without one it gets a config that knows the `relayrunner` and `relayrunner-container` labels, so a repo with its own file should list them there. Only orgs in `CONTAINER_RUNNER_ORGS` get lint, like container runners.

## Container runners

Jobs with `runs-on: relayrunner-container` run on a real runner in a Cloudflare Container (`src/container-runner.ts`, `src/durable-objects/container-runner.ts`). On `queued`, a `ContainerRunner` Durable Object keyed by job id mints a one-job JIT runner on that label and starts a `standard-1` container (½ vCPU, 4 GiB) from GitHub's runner image with Node 24, pnpm, oxlint and oxfmt preinstalled (`container/Dockerfile`). Node sits in the tool cache, so `actions/setup-node` with `node-version: 24` needs no download. The runner takes one job and exits, which stops the container. A one-minute alarm stops a container whose runner got no job within 10 minutes or ran past an hour, and deletes its runner.

Only orgs in `CONTAINER_RUNNER_ORGS` get containers, since each one is billed to this account. Runners join the org's runner group named **Default Public** when it exists, and Default otherwise. Container runners are one-job and disposable, so that group can safely allow public repositories. `wrangler deploy` builds the image, so deploying needs Docker.

## Actions usage

Every 15 minutes a cron reads each connected org's Actions usage from GitHub billing (`src/actions-billing.ts`): `GET /orgs/{org}` for the plan, `/organizations/{org}/settings/billing/usage` for this UTC month's rows, and `/settings/billing/budgets` for the Actions budget, all with the installation token (needs Organization Administration: read). Each poll reads the whole month and replaces that installation's `actions_usage` rows (one per repo and SKU, summed over the month) in a single insert; `actions_billing` holds the plan, budget and last error; `actions_usage_reading` keeps 48 hours of running totals for the burn rate. `GET /api/usage/actions` returns each of the workspace's accounts: plan quota, minutes used in private and unknown repos (in Linux 2-core minutes), gross and net USD, burn rate per hour, and a reason when it's not available (personal accounts, enterprise orgs, a missing permission, an unknown plan).

The same cron sweeps stale pick runners (`src/pick-sweep.ts`). The hourly cron checks dead letters and drops job timings and workflow runs past retention.

## Layout

- `src/app.ts` builds the Hono app. Routes after `attachSession` get `c.var.auth`, `c.var.user` and `c.var.session`. The auth instance is made per request because Workers only hand out bindings per request. Better Auth's cookie cache is on, so most session checks skip D1.
- Workspaces are Better Auth organizations stored under gateway names: `workspace`, `workspace_member`, `workspace_invitation` and `session.active_workspace_id` (mapped in `workspaces()` in `src/auth.ts`). `github_installation` is keyed by the installation id with one nullable `workspace_id`, so a workspace connects many installations and each installation belongs to at most one workspace (null while unclaimed). Routes that act on a workspace go behind `requireWorkspace` (`src/middleware/workspace.ts`), which checks membership in D1.
- `src/db/schema.ts` is the Drizzle schema for D1. `pnpm db:generate` writes migrations into `migrations/`, and Wrangler applies them. See [Migrations](#migrations).
- `src/durable-objects/` holds the Durable Objects: `PickRunner` (one per pick job), `Router` (one per workspace, holding machine reservations and routes), `MachineLink` (one per machine, holding its WebSocket), `LintRunner` (one per commit or lint job) and `ContainerRunner` (one per container job). Logic that doesn't need Durable Object APIs, such as `src/routing.ts` and `durable-objects/machine-session.ts`, lives beside them so it can be tested on its own.

## Migrations

Change `src/db/schema.ts`, then run `pnpm db:generate`. Drizzle names the file with a UTC timestamp prefix (`20261104160202_workspaces.sql`), so two branches that each add a migration don't both claim `0002`. Don't use `wrangler d1 migrations create`, which numbers files and skips the Drizzle snapshot. `src/migrations.test.ts` fails on any file that isn't timestamp-prefixed or isn't in `migrations/meta/_journal.json`.

Merging to `main` applies new migrations to the production database: the `Apply D1 migrations` workflow runs `pnpm db:migrate:remote` with the `CLOUDFLARE_API_TOKEN` secret. It is the only thing that migrates production: the Workers Builds deploy (`pnpm run deploy:api`) does not. Migrations must be safe to run against the Worker that's already deployed, since the workflow can land before the new Worker does.

The first four migrations were renamed from `0000_init.sql`, `0001_workspaces.sql`, `0002_installation_repository_selection.sql` and `0003_installation_github_state_at.sql`. Wrangler tracks applied migrations by filename, so `db:migrate:local` and `db:migrate:remote` first run `scripts/rename-legacy-migrations.sql`, which renames those rows in `d1_migrations` and does nothing on a fresh database or once they're renamed. It can go once every database (including your local `.wrangler` state) has been migrated with it.

## Run it locally

```sh
cp .dev.vars.example .dev.vars   # fill in the GitHub App's OAuth client and a secret
pnpm db:migrate:local
pnpm dev                          # http://localhost:8787/api/health
```

## Deploy

`wrangler.jsonc` pins the RelayRunner Cloudflare account (`account_id`), so wrangler targets it even if your login can see other accounts. Then:

```sh
pnpm db:migrate:remote                   # the D1 Migrations workflow does this on merge to main; only needed by hand for a new database
wrangler secret put BETTER_AUTH_SECRET   # and GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET
wrangler r2 bucket create relayrunner-webhook-dead-letters   # once; a deploy fails until it exists
wrangler r2 bucket lifecycle add relayrunner-webhook-dead-letters expire-30d --expire-days 30
pnpm run deploy:api                      # from the repo root; deploys only, no migrations
```

`GITHUB_APP_PRIVATE_KEY` comes from the account's Secrets Store, not `wrangler secret put`, and a deploy fails until it exists there. Store it once as PKCS#8 PEM (GitHub downloads PKCS#1, which WebCrypto can't import):

```sh
# The prompt only takes one line, so pass the PEM as --value. Command substitution keeps it out of
# shell history.
wrangler secrets-store secret create eac3493b9fef4234a832f5f3fdcc8a41 --remote --scopes workers \
  --name GITHUB_APP_PRIVATE_KEY --value "$(openssl pkcs8 -topk8 -nocrypt -in relayrunner.*.private-key.pem)"
```

The browser never talks to this Worker directly: the dashboard Worker (`apps/web`) forwards `/api/*` here over a service binding, so `BETTER_AUTH_URL` (in `wrangler.jsonc` vars) is the dashboard's origin: `https://relayrunner-app.relayrun.workers.dev` until `app.relayrunner.dev` moves to this account. `.dev.vars` overrides it for local dev. Deploy this Worker before `apps/web`, since the binding needs it to exist. The GitHub App's callback URL is `<BETTER_AUTH_URL>/api/auth/callback/github`. Its webhook URL points at the webhooks Worker (`apps/webhooks`), not this one.

### Sign-in on dashboard previews

Workers Builds previews of the dashboard (`<alias>-relayrunner-app.relayrun.workers.dev`) forward `/api/*` to this production Worker too, so a signed-in preview acts on production data. Better Auth's `oAuthProxy` plugin makes sign-in work there without another GitHub callback URL: GitHub always returns to `<BETTER_AUTH_URL>/api/auth/callback/github`, production exchanges the code and redirects to `<preview>/api/auth/callback/github/oauth-proxy` with the profile encrypted under `BETTER_AUTH_SECRET` (valid for 60 seconds), and the preview sets the session cookie. On `relayrun.workers.dev` hosts that cookie is shared across the whole domain (`SESSION_COOKIE_DOMAIN`), so signing in once on production workers.dev or any preview signs you in on every preview URL, per-branch and per-commit alike; signing out anywhere there signs you out everywhere there. Other hosts keep host-only cookies. Only origins matching `PREVIEW_ORIGINS` (wrangler vars) can start a proxied sign-in; any other host gets handed back to production. The interim custom domain `app.relayrunner.app` is in `PREVIEW_ORIGINS` too, so it signs in the same way without a GitHub App change. When the dashboard moves to its own custom domain for good, point `BETTER_AUTH_URL` there, add its callback URL to the GitHub App, and update `PREVIEW_ORIGINS` together.
