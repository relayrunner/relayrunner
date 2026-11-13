# Repository instructions

## Product context

Read [PRODUCT.md](PRODUCT.md) before starting work in this repository. Use it to guide product and implementation decisions.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit message and every pull request title. This applies to each commit you make, not only the squash-merge title, and to cloud agents as much as local ones.

- Write each on a single line in the form `type(scope): description`, such as `feat(api): log workflow jobs that ask for the relayrunner label` or `chore: scaffold pnpm workspace`.
- Use one of these types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`.
- The scope is optional. When you use one, name the app or package, such as `api`, `web`, `webhooks`, `cli`, or `site`.
- Write the description in the imperative mood and in lowercase, with no trailing period.
- Mark a breaking change with `!` after the type or scope, such as `feat(api)!: …`.

Never commit screenshots or other PR images to the repository. Upload them with the Uploads MCP or CLI and attach them to the pull request as a comment. The one exception is the README's images in `.github/readme/`.

## Formatting and checks

Format with oxfmt (`pnpm format`) and lint with Oxlint (`pnpm lint`). Run `pnpm check` before you push; CI runs the same command. The pre-commit hook formats and lints staged files, so don't skip it with `--no-verify`.

## Releasing the CLI

The `relayrunner` npm package (`apps/cli`) is released with [changesets](https://github.com/changesets/changesets). A PR that changes what the CLI does for people who install it adds a `.changeset/*.md` file (`pnpm changeset`) naming `"relayrunner"`, the only package a changeset may name. Merging it makes the Release workflow open a `chore: version packages` PR, and merging that one publishes to npm. Don't bump `apps/cli/package.json` by hand. See [.changeset/README.md](.changeset/README.md).

## Agent skills

The `security-audit` skill from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) is a project default, listed under `skills` in `package.json` and pinned in `skills-lock.json`. Load it for a security audit, a vulnerability review, or a pen test. The canonical copy lives in `.agents/skills`, which Codex, Cursor, and Grok read directly; Claude Code reads it through the `.claude/skills/security-audit` symlink. Don't edit the vendored files by hand, since oxfmt and Oxlint skip them to keep them byte-identical to the lock. Update with `npx skills update`.

The skills in `skills/` are for people who use RelayRunner, not for working on this repo; they install with `npx skills add relayrunner/relayrunner`. When you change a CLI command or flag, the relay version, or the MCP tools, update the matching skill in the same PR. `apps/cli/skills.test.ts` (relay version) and `apps/agents/src/skill.test.ts` (MCP tools) catch the most likely drift.

## Preview URLs and admin views

Dashboard preview URLs and the operator `/admin/*` views sit behind Cloudflare Access. To reach them, send the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers from `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. `GET /admin/access` confirms the token works. See [docs/cloudflare-access.md](docs/cloudflare-access.md).
