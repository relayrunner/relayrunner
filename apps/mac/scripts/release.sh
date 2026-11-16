#!/usr/bin/env bash
# Releases RelayRunner for Mac from this Mac, at the CLI's version, after that CLI release is out
# (its v<version> GitHub release exists). Needs, in this Mac's keychain: a Developer ID Application
# certificate, a notarytool profile named "relayrunner" (xcrun notarytool store-credentials) and
# Sparkle's private key (setup-sparkle.sh's bin/generate_keys). Also gh, signed in.
#
#   apps/mac/scripts/release.sh            build, notarize and publish
#   apps/mac/scripts/release.sh --dry-run  build and notarize only, into apps/mac/dist
#
# Publishing uploads the DMG and the update zip to the v<version> release, bumps the cask in
# relayrunner/homebrew-tap, and opens a PR with the new apps/site/public/mac/appcast.xml. Apps
# see the update once that PR merges and the site deploys.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd)"
dry_run=false
[[ "${1:-}" == "--dry-run" ]] && dry_run=true

repo=relayrunner/relayrunner
version="$(node -p "require('$root/apps/cli/package.json').version")"
tag="v$version"
dmg="dist/RelayRunner-$version.dmg"
zip="dist/RelayRunner-$version.zip"
profile="${RELAYRUNNER_NOTARY_PROFILE:-relayrunner}"
step() { printf '\n==> %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }

step "Checking what the release needs"
identity="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
[[ -n "$identity" ]] || fail "no Developer ID Application certificate in the keychain."
xcrun notarytool history --keychain-profile "$profile" >/dev/null ||
  fail "no notarytool profile \"$profile\": run xcrun notarytool store-credentials $profile."
if ! $dry_run; then
  gh auth status >/dev/null 2>&1 || fail "gh isn't signed in: run gh auth login."
  gh release view "$tag" --repo "$repo" >/dev/null 2>&1 ||
    fail "$repo has no $tag release yet. Release the CLI first, then run this from that commit."
  [[ -z "$(git -C "$root" status --porcelain)" ]] || fail "the checkout has uncommitted changes."
fi
echo "Version $version, signed by $identity"

step "Building"
RELAYRUNNER_SIGN_IDENTITY="$identity" bash scripts/build-app.sh
app=dist/RelayRunner.app

notarize() {
  xcrun notarytool submit "$1" --keychain-profile "$profile" --wait --timeout 30m
}

step "Notarizing the app"
ditto -c -k --keepParent "$app" dist/notarize.zip
notarize dist/notarize.zip
rm dist/notarize.zip
xcrun stapler staple "$app"

step "Making the DMG"
staging="$(mktemp -d)"
ditto "$app" "$staging/RelayRunner.app"
ln -s /Applications "$staging/Applications"
rm -f "$dmg" "$zip"
hdiutil create -quiet -fs APFS -format ULFO -volname RelayRunner -srcfolder "$staging" "$dmg"
codesign --force --timestamp --sign "$identity" "$dmg"
notarize "$dmg"
xcrun stapler staple "$dmg"
spctl --assess --type install --verbose "$dmg"
spctl --assess --type execute --verbose "$app"

step "Signing the update"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
sparkle="$(bash scripts/setup-sparkle.sh)"
# Prints sparkle:edSignature="…" length="…", with the private key from the keychain.
signature="$("$sparkle/bin/sign_update" "$zip")"
appcast="$root/apps/site/public/mac/appcast.xml"
mkdir -p "$(dirname "$appcast")"
cat >"$appcast" <<XML
<?xml version="1.0" encoding="utf-8"?>
<!-- Written by apps/mac/scripts/release.sh: the newest RelayRunner for Mac, for Sparkle. -->
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>RelayRunner for Mac</title>
    <item>
      <title>$version</title>
      <pubDate>$(LC_ALL=C date -u "+%a, %d %b %Y %H:%M:%S +0000")</pubDate>
      <sparkle:version>$version</sparkle:version>
      <sparkle:shortVersionString>$version</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <sparkle:releaseNotesLink>https://github.com/$repo/releases/tag/$tag</sparkle:releaseNotesLink>
      <enclosure url="https://github.com/$repo/releases/download/$tag/RelayRunner-$version.zip" $signature type="application/octet-stream"/>
    </item>
  </channel>
</rss>
XML

if $dry_run; then
  git -C "$root" checkout -- apps/site/public/mac/appcast.xml 2>/dev/null || rm -f "$appcast"
  echo
  echo "Dry run: built and notarized $dmg and $zip. Nothing was published."
  exit 0
fi

step "Uploading to the $tag release"
gh release upload "$tag" "$dmg" "$zip" --repo "$repo" --clobber

step "Bumping the Homebrew cask"
sha="$(shasum -a 256 "$dmg" | cut -d' ' -f1)"
tap="$(mktemp -d)/homebrew-tap"
gh repo clone relayrunner/homebrew-tap "$tap" -- --quiet
mkdir -p "$tap/Casks"
cat >"$tap/Casks/relayrunner.rb" <<RUBY
cask "relayrunner" do
  version "$version"
  sha256 "$sha"

  url "https://github.com/$repo/releases/download/v#{version}/RelayRunner-#{version}.dmg"
  name "RelayRunner"
  desc "Take GitHub Actions jobs on your Mac from the menu bar"
  homepage "https://relayrunner.app/"

  livecheck do
    url "https://relayrunner.app/mac/appcast.xml"
    strategy :sparkle
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: ">= :sonoma"

  app "RelayRunner.app"

  # ~/.relayrunner is shared with the relayrunner CLI, so it stays.
  zap trash: "~/Library/Preferences/app.relayrunner.mac.plist"
end
RUBY
git -C "$tap" add Casks/relayrunner.rb
git -C "$tap" commit --quiet -m "relayrunner $version"
git -C "$tap" push --quiet

step "Opening the appcast PR"
branch="release/mac-$tag"
git -C "$root" checkout -B "$branch"
git -C "$root" add apps/site/public/mac/appcast.xml
git -C "$root" commit --quiet -m "chore(mac): release RelayRunner for Mac $version"
git -C "$root" push --quiet -u origin "$branch"
gh pr create --repo "$repo" --head "$branch" --title "chore(mac): release RelayRunner for Mac $version" \
  --body "Points the Mac app's update feed at $version ($tag). The DMG and update zip are on the [$tag release](https://github.com/$repo/releases/tag/$tag), and the Homebrew cask is bumped. Apps get the update once this merges and the site deploys."

echo
echo "Released RelayRunner for Mac $version. Merge the appcast PR to ship the update to existing installs."
