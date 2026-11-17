#!/usr/bin/env bash
# Installs the npm packages the way a user would and checks `relayrunner` runs.
#
#   scripts/smoke-npm-package.sh                      build this platform's Rust CLI and pack it
#   scripts/smoke-npm-package.sh <tarball>...         install these (relayrunner and a platform package)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT

tarballs=()
for tarball in "$@"; do
  [[ "$tarball" == /* ]] || tarball="$PWD/$tarball"
  tarballs+=("$tarball")
done

if [[ ${#tarballs[@]} -eq 0 ]]; then
  (cd "$root/apps/cli" && cargo build --locked --release)
  # Spelled as Node and the package names spell it, such as linux-x64.
  platform="$(node -p 'process.platform + "-" + process.arch')"
  mkdir "$smoke_dir/bins"
  cp "$root/apps/cli/target/release/relayrunner" "$smoke_dir/bins/relayrunner-$platform"
  mapfile -t tarballs < <(node "$root/scripts/npm-packages.mjs" "$smoke_dir/bins" "$smoke_dir/out" --allow-missing)
fi

prefix="$smoke_dir/relayrunner-install"
# The other platforms' packages are optional, so npm skips them, even when they aren't published.
npm install --global --prefix "$prefix" "${tarballs[@]}"
export PATH="$prefix/bin:$PATH"

relayrunner --help
bash "$root/scripts/smoke-cli-binary.sh" "$(command -v relayrunner)"
