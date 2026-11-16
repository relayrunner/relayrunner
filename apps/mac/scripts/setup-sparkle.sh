#!/usr/bin/env bash
# Fetches Sparkle's release (the framework the app embeds, plus generate_keys and sign_update) into
# ~/.local/share/relayrunner-release, checks its sha256, and prints the folder. The version matches
# Package.swift's.
set -euo pipefail

version=2.9.4
sha256=ce89daf967db1e1893ed3ebd67575ed82d3902563e3191ca92aaec9164fbdef9
dir="${RELAYRUNNER_SPARKLE_DIR:-$HOME/.local/share/relayrunner-release/sparkle-$version}"

if [[ -d "$dir/Sparkle.framework" && -x "$dir/bin/sign_update" ]]; then
  echo "$dir"
  exit 0
fi

archive="$(mktemp -d)/Sparkle-$version.tar.xz"
curl --fail --silent --show-error --location --retry 3 --output "$archive" \
  "https://github.com/sparkle-project/Sparkle/releases/download/$version/Sparkle-$version.tar.xz"
echo "$sha256  $archive" | shasum -a 256 -c - >&2
mkdir -p "$dir.partial"
tar -xJf "$archive" -C "$dir.partial"
rm -rf "$dir"
mv "$dir.partial" "$dir"
echo "$dir"
