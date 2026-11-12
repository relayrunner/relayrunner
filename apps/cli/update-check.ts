// Tells someone at the terminal when npm has a newer relayrunner. It asks the npm registry at most
// once a day and keeps the answer in <home>/update-check.json, so most runs read a file and never
// touch the network. Any failure (offline, slow registry, unreadable cache) means no notice.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { relayrunnerHome, userAgent } from "./paths.ts";
import { cliVersion } from "./version.ts";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = "https://registry.npmjs.org/relayrunner/latest";
const TIMEOUT_MS = 3_000;

const Cache = z.object({ checkedAt: z.number(), latest: z.string() });
type Cache = z.infer<typeof Cache>;

export interface UpdateCheckOptions {
  now?: number;
  current?: string;
  fetch?: typeof fetch;
}

/** The newer version npm has, or null when this CLI is current or the check couldn't tell. */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<string | null> {
  const now = options.now ?? Date.now();
  const current = options.current ?? cliVersion;
  let cache = readCache();
  if (!cache || now - cache.checkedAt >= CHECK_INTERVAL_MS) {
    const latest = await fetchLatest(options.fetch ?? fetch);
    if (latest) {
      cache = { checkedAt: now, latest };
      writeCache(cache);
    }
  }
  return cache && isNewer(cache.latest, current) ? cache.latest : null;
}

/** The line to print for a newer version, with the command that updates the way this one runs. */
export function updateNotice(latest: string, current = cliVersion, argv1 = process.argv[1] ?? "") {
  // npx runs packages from its cache under .../_npx/<hash>/node_modules.
  const viaNpx = /[\\/]_npx[\\/]/.test(argv1);
  const command = viaNpx
    ? "npx relayrunner@latest connect"
    : "npm install --global relayrunner@latest";
  return `relayrunner ${latest} is available (you have ${current}). Update with \`${command}\`.`;
}

// Only plain x.y.z releases count as newer, so a prerelease on `latest` never nags.
export function isNewer(candidate: string, current: string) {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

function parse(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

async function fetchLatest(fetcher: typeof fetch) {
  try {
    const response = await fetcher(REGISTRY_URL, {
      headers: { accept: "application/json", "user-agent": userAgent },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = z.object({ version: z.string() }).safeParse(await response.json());
    return body.success ? body.data.version : null;
  } catch {
    return null;
  }
}

function cachePath() {
  return join(relayrunnerHome(), "update-check.json");
}

function readCache(): Cache | null {
  try {
    const parsed = Cache.safeParse(JSON.parse(readFileSync(cachePath(), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCache(cache: Cache) {
  try {
    mkdirSync(relayrunnerHome(), { recursive: true });
    writeFileSync(cachePath(), `${JSON.stringify(cache)}\n`);
  } catch {
    // A cache we can't write only means asking npm again next time.
  }
}
