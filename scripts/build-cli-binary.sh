#!/usr/bin/env bash
# Builds the CLI as one executable that carries its own runtime (Bun's), for apps that bundle it,
# such as the Mac menu bar app. Nothing else needs to be installed to run it.
#
#   scripts/build-cli-binary.sh [target...]   (default: bun-darwin-arm64)
#
# Each target lands in apps/cli/dist-bin/relayrunner-<os>-<arch>, outside the npm package's dist/.
# Targets are Bun's, such as bun-darwin-arm64 or bun-linux-x64, and any of them builds on any OS.
set -euo pipefail

cd "$(dirname "$0")/../apps/cli"
mkdir -p dist-bin
for target in "${@:-bun-darwin-arm64}"; do
  bun build cli.ts --compile --minify --target="$target" --outfile "dist-bin/relayrunner-${target#bun-}"
done
