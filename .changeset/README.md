# Changesets

Pending releases of the `relayrunner` npm package (the CLI: `apps/cli` on npm, built from `apps/cli-rs`) and of
`@relayrunner/mac`, the Mac app in `apps/mac`, which has its own version.

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

A PR that changes the Mac app names `"@relayrunner/mac"` instead (or as well),
written for someone who uses the app.

Use `patch` for fixes, `minor` for new features and `major` for breaking
changes. `relayrunner` and `@relayrunner/mac` are the only packages a changeset
may name. The API, web app and other workspace packages are private and deploy
through Workers Builds, so they never get a changeset. `pnpm changeset:lint`
(run in CI) rejects any other name.

## Release flow

1. Merge PRs with changesets to `main`.
2. The **Release** workflow (`.github/workflows/publish-npm.yml`) opens or
   updates a `chore: version packages` PR that bumps `apps/cli/package.json`
   and writes `apps/cli/CHANGELOG.md`.
   It bumps `apps/mac/package.json` and writes `apps/mac/CHANGELOG.md` too when
   the Mac app has changesets.
3. Merging that PR publishes `relayrunner` to npm with trusted publishing (no
   npm token), then tags `v<version>` and creates a GitHub release. The Mac app
   isn't published by the workflow: run `apps/mac/scripts/release.sh` on a Mac
   from that commit, which makes its `mac-v<version>` release.

Don't edit the `version` in `apps/cli/package.json` or `apps/mac/package.json`
by hand; changesets owns them.
