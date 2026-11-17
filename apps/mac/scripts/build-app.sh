#!/usr/bin/env bash
# Builds RelayRunner.app for Apple silicon into apps/mac/dist: the menu bar app, with the Rust
# build of the CLI (apps/cli) inside it and Sparkle for updates. Needs Xcode or its command line
# tools, Node and Rust (rustup). The version is apps/mac/package.json's; the CLI's goes in
# Info.plist too, for the About tab.
#
# Signed ad hoc, so it runs on the Mac that built it, unless RELAYRUNNER_SIGN_IDENTITY names a
# Developer ID identity: then every part is signed with the hardened runtime and a timestamp, as
# notarization needs (scripts/release.sh does that).
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd)"
version="$(node -p "require('./package.json').version")"
cli_version="$(node -p "require('$root/apps/cli/package.json').version")"
identity="${RELAYRUNNER_SIGN_IDENTITY:--}"
sparkle="$(bash scripts/setup-sparkle.sh)"

cargo build --release --locked --manifest-path "$root/apps/cli/Cargo.toml" --target aarch64-apple-darwin
swift build -c release --arch arm64
bin="$(swift build -c release --arch arm64 --show-bin-path)"

app=dist/RelayRunner.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Helpers" "$app/Contents/Resources" "$app/Contents/Frameworks"
cp "$bin/RelayRunner" "$app/Contents/MacOS/RelayRunner"
cp "$root/apps/cli/target/aarch64-apple-darwin/release/relayrunner" "$app/Contents/Helpers/relayrunner"
cp Resources/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
ditto "$sparkle/Sparkle.framework" "$app/Contents/Frameworks/Sparkle.framework"
sed -e "s/__VERSION__/$version/g" -e "s/__CLI_VERSION__/$cli_version/g" Info.plist >"$app/Contents/Info.plist"

if [[ "$identity" == "-" ]]; then
  sign=(codesign --force --sign -)
else
  if grep -q __SPARKLE_PUBLIC_KEY__ Info.plist; then
    echo "Info.plist has no Sparkle public key yet (run scripts/setup-sparkle.sh, then its bin/generate_keys)." >&2
    exit 1
  fi
  sign=(codesign --force --options runtime --timestamp --sign "$identity")
fi
# Inside out, as Sparkle's docs list its parts.
framework="$app/Contents/Frameworks/Sparkle.framework/Versions/B"
"${sign[@]}" "$framework/XPCServices/Installer.xpc"
"${sign[@]}" --preserve-metadata=entitlements "$framework/XPCServices/Downloader.xpc"
"${sign[@]}" "$framework/Autoupdate"
"${sign[@]}" "$framework/Updater.app"
"${sign[@]}" "$app/Contents/Frameworks/Sparkle.framework"
"${sign[@]}" --identifier app.relayrunner.mac.cli "$app/Contents/Helpers/relayrunner"
"${sign[@]}" "$app"
codesign --verify --deep --strict "$app"
echo "Built $PWD/$app ($version, CLI $cli_version)"
