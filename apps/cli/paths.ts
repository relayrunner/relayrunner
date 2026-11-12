import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cliVersion } from "./version.ts";

// Everything the CLI keeps on disk lives here. RELAYRUNNER_HOME overrides it (tests use it too).
export function relayrunnerHome() {
  return resolve(process.env.RELAYRUNNER_HOME || join(homedir(), ".relayrunner"));
}

// One directory per installed actions/runner version: <home>/runner/<version>.
export function runnersDir() {
  return join(relayrunnerHome(), "runner");
}

export const userAgent = `relayrunner-cli/${cliVersion}`;
