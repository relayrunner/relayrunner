# Changesets

Pending releases of the `relayrunner` npm package (the CLI in `apps/cli`).

## Adding a changeset

A PR that changes what the CLI does for people who install it adds a file here:

```sh
pnpm changeset
```

Or write `.changeset/<slug>.md` by hand:

```md
---
"relayrunner": minor
---

What changed, written for someone who runs the CLI.
```

Use `patch` for fixes, `minor` for new features and `major` for breaking
changes. `relayrunner` is the only package a changeset may name. The API, web
app and other workspace packages are private and deploy through Workers Builds,
so they never get a changeset. `pnpm changeset:lint` (run in CI) rejects any
other name.

## Release flow

1. Merge PRs with changesets to `main`.
2. The **Release** workflow (`.github/workflows/publish-npm.yml`) opens or
   updates a `chore: version packages` PR that bumps `apps/cli/package.json`
   and writes `apps/cli/CHANGELOG.md`.
3. Merging that PR publishes `relayrunner` to npm with trusted publishing (no
   npm token), then tags `v<version>` and creates a GitHub release.

Don't edit the `version` in `apps/cli/package.json` by hand; changesets owns it.
