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
  (cd "$root/apps/cli-rs" && cargo build --locked --release)
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin-arm64 ;;
    Darwin-x86_64) platform=darwin-x64 ;;
    Linux-aarch64) platform=linux-arm64 ;;
    Linux-x86_64) platform=linux-x64 ;;
    *) echo "No relayrunner package for $(uname -s) $(uname -m)." >&2; exit 1 ;;
  esac
  mkdir "$smoke_dir/bins"
  cp "$root/apps/cli-rs/target/release/relayrunner" "$smoke_dir/bins/relayrunner-$platform"
  mapfile -t tarballs < <(node "$root/scripts/npm-packages.mjs" "$smoke_dir/bins" "$smoke_dir/out" --allow-missing)
fi

prefix="$smoke_dir/relayrunner-install"
# The other platforms' packages are optional, so npm skips them, even when they aren't published.
npm install --global --prefix "$prefix" "${tarballs[@]}"
export PATH="$prefix/bin:$PATH"

relayrunner --help
bash "$root/scripts/smoke-cli-binary.sh" "$(command -v relayrunner)"
