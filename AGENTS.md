# Repository instructions

## Product context

Read [PRODUCT.md](PRODUCT.md) before starting work in this repository. Use it to guide product and implementation decisions.

## Writing copy

These rules apply to anything people read: the site, the docs, dashboard labels, CLI output, emails, and MCP tool descriptions.

- Avoid mannered prose. That means no clipped two-fragment headlines ("Fallbacks first. No surprises."), no "X, not Y" or "No A, no B" cadences, no cute turns of phrase, and no repeated catchphrases. A headline says what the reader can do, and the body explains how it works in full sentences.
- Use active voice with a real subject, such as "you", "the job", "the dashboard", or "GitHub". Don't make the product name the subject of a body sentence ("RelayRunner runs…").
- Be clear before you are complete. Leave out caveats, edge cases, and internal detail that don't change what the reader does.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit message and every pull request title. This applies to each commit you make, not only the squash-merge title, and to cloud agents as much as local ones.

- Write each on a single line in the form `type(scope): description`, such as `feat(api): log workflow jobs that ask for the relayrunner label` or `chore: scaffold pnpm workspace`.
- Use one of these types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`.
- The scope is optional. When you use one, name the app or package, such as `api`, `web`, `webhooks`, `cli`, or `site`.
- Write the description in the imperative mood and in lowercase, with no trailing period.
- Mark a breaking change with `!` after the type or scope, such as `feat(api)!: …`.

Never commit screenshots or other PR images to the repository. Upload them with the Uploads MCP or CLI and attach them to the pull request as a comment. The exceptions are the dashboard screenshots the README and the site show, in `.github/readme/` and `apps/site/public/screenshots/`. `pnpm screenshots` captures them from the dashboard's sample data, so refresh them with it rather than by hand.

## Formatting and checks

Format with oxfmt (`pnpm format`) and lint with Oxlint (`pnpm lint`). `pnpm knip` fails on exports and files nothing imports: delete them, or tag an export that is a deliberate API with `@public`. Run `pnpm check` before you push; CI runs the same command. The pre-commit hook formats and lints staged files, so don't skip it with `--no-verify`.

## API errors

The API answers every failure with a code from `@relayrunner/errors`: `throw new AppError("CODE")` in a route, and add new codes to `packages/errors/src/codes.ts` rather than returning a string. See [packages/errors/README.md](packages/errors/README.md).

## Feature flags

Ship unreleased user-facing work behind a Cloudflare Flagship flag, so it can merge and deploy before anyone sees it. Add the key to `FLAG_KEYS` in `packages/api-types/src/flags.ts`, guard the API with `requireFlag` or `isFlagOn` (`apps/api/src/flags.ts`) and the dashboard with `useFlag`, `<Flag>` or `requireFlagRoute` (`apps/web/src/lib/flags.tsx`). Don't create or change flags in Flagship unless a maintainer asks. See [docs/feature-flags.md](docs/feature-flags.md).

## Releasing the CLI

The `relayrunner` npm package (the Rust CLI in `apps/cli`, shipped as a launcher plus one binary package per platform) is released with [changesets](https://github.com/changesets/changesets). A PR that changes what the CLI does for people who install it adds a `.changeset/*.md` file (`pnpm changeset`) naming `"relayrunner"`. A PR that changes the Mac app (`apps/mac`) names `"@relayrunner/mac"`, which has its own version; those are the only two names a changeset may use. Merging it makes the Release workflow open a `chore: version packages` PR, and merging that one publishes the CLI to npm (the Mac app ships with `pnpm release:mac` (`apps/mac/scripts/release.sh` in a clean worktree of main), run on a Mac that holds the signing certificate; it publishes a GitHub release, the Homebrew cask and an appcast PR, so run it only on a maintainer's explicit go). Don't bump either `package.json` version by hand. See [.changeset/README.md](.changeset/README.md).

## Cloudflare CLI

Use the [cf CLI](https://developers.cloudflare.com/cf/) for Cloudflare account and resource work: D1, R2, queues, Worker secrets, the Secrets Store, DNS, Access and anything else in the Cloudflare API. Find a command with `cf cli search "<task>"` and check it with `--dry-run` before running it, rather than translating a Wrangler command from memory. `cf` reads the account from `CLOUDFLARE_ACCOUNT_ID`, not from `wrangler.jsonc`, so load the repo's `.env` first.

Keep Wrangler for what reads `wrangler.jsonc`: `wrangler dev`, `wrangler deploy`, `wrangler preview` (Workers Builds), `wrangler containers build`, D1 migrations (`pnpm db:migrate:*`, until `cf` 1.0 is stable) and the local Secrets Store that `wrangler dev` uses. Never run `cf dev`, `cf build` or `cf deploy` here: until the Workers move to `cloudflare.config.ts` with `cf migrate`, they ignore `wrangler.jsonc` and can rewrite `package.json`.

## Agent skills

The `security-audit` skill from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) is a project default, listed under `skills` in `package.json` and pinned in `skills-lock.json`. Load it for a security audit, a vulnerability review, or a pen test. The canonical copy lives in `.agents/skills`, which Codex, Cursor, and Grok read directly; Claude Code reads it through the `.claude/skills/security-audit` symlink. Don't edit the vendored files by hand, since oxfmt and Oxlint skip them to keep them byte-identical to the lock. Update with `npx skills update`.

The skills in `skills/` are for people who use RelayRunner, not for working on this repo; they install with `npx skills add relayrunner/relayrunner`. When you change a CLI command or flag, the relay version, or the MCP tools, update the matching skill in the same PR. `skills_show_the_relay_version_init_writes` in `apps/cli/src/init/workflows.rs` (relay version) and `apps/agents/src/skill.test.ts` (MCP tools) catch the most likely drift.

## Preview URLs and admin views

Dashboard preview URLs and the operator `/admin/*` views sit behind Cloudflare Access. To reach them, send the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers from `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. `GET /admin/access` confirms the token works. See [docs/cloudflare-access.md](docs/cloudflare-access.md).
