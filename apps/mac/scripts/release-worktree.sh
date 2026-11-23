#!/usr/bin/env bash
# Runs release.sh from a clean worktree of origin/main next to this checkout, so the checkout you
# work in stays as it is. Passes its arguments on to release.sh.
#
#   pnpm release:mac:dry-run   build, sign and notarize only
#   pnpm release:mac           and publish
#
# The worktree is ../relayrunner-release, or RELAYRUNNER_RELEASE_WORKTREE. The first run creates it;
# later runs move it to the latest origin/main, which leaves the release/mac-v<version> branch the
# last release made where it is.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
worktree="${RELAYRUNNER_RELEASE_WORKTREE:-$(dirname "$root")/relayrunner-release}"
step() { printf '\n==> %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }

step "Preparing $worktree at origin/main"
git -C "$root" fetch --quiet origin main
if [[ -d "$worktree" ]]; then
  git -C "$worktree" rev-parse --git-dir >/dev/null 2>&1 || fail "$worktree exists and isn't a git worktree."
  [[ -z "$(git -C "$worktree" status --porcelain)" ]] ||
    fail "$worktree has uncommitted changes. Commit, stash or remove them first."
  git -C "$worktree" checkout --quiet --detach origin/main
else
  git -C "$root" worktree add --quiet --detach "$worktree" origin/main
fi
git -C "$worktree" log --oneline -1

step "Installing dependencies"
(cd "$worktree" && pnpm install --frozen-lockfile)

exec "$worktree/apps/mac/scripts/release.sh" "$@"
