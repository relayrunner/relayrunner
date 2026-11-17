#!/usr/bin/env bash
# Checks a build of the CLI (apps/cli) runs, and that `connect --events` keeps
# stdout to JSON lines: here, the one error it stops with when it can't reach a gateway.
set -euo pipefail

binary="$1"
home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT

"$binary" --version
stdout="$(RELAYRUNNER_HOME="$home" "$binary" connect --events --no-isolated --server http://localhost:9 </dev/null 2>/dev/null || true)"
echo "$stdout"
[[ "$(wc -l <<<"$stdout")" -eq 1 ]] || { echo "expected one line on stdout" >&2; exit 1; }
node -e 'const e = JSON.parse(process.argv[1]); if (e.v !== 1 || e.type !== "error") process.exit(1)' "$stdout"
