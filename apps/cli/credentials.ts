// The machine's identity on this computer: which gateway it enrolled with and the machine token
// that gateway handed back. Written once by the device-code login and read on every `connect`.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { relayrunnerHome } from "./paths.ts";
import { sendsTokenSafely } from "./server.ts";

export const Credentials = z.object({
  // The gateway's origin, such as https://app.relayrunner.dev. Plain http only for localhost.
  server: z.url().refine((server) => sendsTokenSafely(new URL(server))),
  machine: z.object({ id: z.string().min(1), name: z.string() }),
  workspace: z.object({ id: z.string().min(1), name: z.string(), slug: z.string().nullish() }),
  // rrm_…, sent as a bearer token on the WebSocket upgrade.
  token: z.string().min(1),
});
export type Credentials = z.infer<typeof Credentials>;

export function credentialsPath(home = relayrunnerHome()) {
  return join(home, "machine.json");
}

// The stored credentials, or null if there are none or the file isn't ours to read.
export function readCredentials(path = credentialsPath()): Credentials | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = Credentials.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Only the user can read the token: the directory is 0700 and the file 0600. Written to a temp
// file first so a crash never leaves half a token behind.
export function writeCredentials(credentials: Credentials, path = credentialsPath()) {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function deleteCredentials(path = credentialsPath()) {
  rmSync(path, { force: true });
}
