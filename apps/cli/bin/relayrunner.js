#!/usr/bin/env node
// Runs the relayrunner binary built for this computer. npm installs it as an optional dependency,
// one package per platform, and skips the ones for other platforms (scripts/npm-platform-packages.mjs).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const platform = `${process.platform}-${process.arch}`;

function binary() {
  if (!PLATFORMS.includes(platform)) {
    console.error("relayrunner runs on macOS and Linux, on x64 or arm64.");
    process.exit(1);
  }
  try {
    return createRequire(import.meta.url).resolve(`@relayrunner/cli-${platform}/relayrunner`);
  } catch {
    console.error(
      `relayrunner's binary for ${platform} isn't installed. Reinstall without --omit=optional or --no-optional.`,
    );
    process.exit(1);
  }
}

const child = spawn(binary(), process.argv.slice(2), { stdio: "inherit" });
// Ctrl-C reaches the binary from the terminal already, and a second one means "stop the running
// jobs now", so this process only waits. Other signals sent to it alone go on to the binary.
process.on("SIGINT", () => {});
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`Couldn't start relayrunner: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
