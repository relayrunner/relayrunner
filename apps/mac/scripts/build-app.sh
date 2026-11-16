#!/usr/bin/env bash
# Builds RelayRunner.app for Apple silicon into apps/mac/dist: the menu bar app, with the CLI
# compiled into it (scripts/build-cli-binary.sh), signed ad hoc so it runs on this Mac. Needs
# Xcode or its command line tools, Node and Bun. The version is the CLI's.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd)"
version="$(node -p "require('$root/apps/cli/package.json').version")"

bash "$root/scripts/build-cli-binary.sh" bun-darwin-arm64
swift build -c release --arch arm64
bin="$(swift build -c release --arch arm64 --show-bin-path)"

app=dist/RelayRunner.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Helpers"
cp "$bin/RelayRunner" "$app/Contents/MacOS/RelayRunner"
cp "$root/apps/cli/dist-bin/relayrunner-darwin-arm64" "$app/Contents/Helpers/relayrunner"
sed "s/__VERSION__/$version/g" Info.plist >"$app/Contents/Info.plist"

codesign --force --sign - "$app/Contents/Helpers/relayrunner"
codesign --force --sign - "$app"
echo "Built $PWD/$app ($version)"
