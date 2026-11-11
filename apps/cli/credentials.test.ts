import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  saveRotatedToken,
  withCurrentToken,
  writeCredentials,
  type Credentials,
} from "./credentials.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "relayrunner-credentials-"));
  dirs.push(dir);
  return join(dir, "home");
}

const credentials: Credentials = {
  server: "https://app.relayrunner.dev",
  machine: { id: "m1", name: "laptop" },
  token: "rrm_secret",
};

test("writes the token readable only by the user and reads it back", () => {
  const path = credentialsPath(tempHome());
  expect(readCredentials(path)).toBeNull();

  writeCredentials(credentials, path);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  expect(readCredentials(path)).toEqual(credentials);

  deleteCredentials(path);
  expect(readCredentials(path)).toBeNull();
});

test("still reads a file from CLI 0.5.0, which saved one workspace", () => {
  const path = credentialsPath(tempHome());
  const old = { ...credentials, workspace: { id: "w1", name: "Acme", slug: "acme" } };
  writeCredentials(old, path);
  expect(readCredentials(path)).toMatchObject(credentials);
});

test("a damaged file reads as no credentials", () => {
  const path = credentialsPath(tempHome());
  writeCredentials(credentials, path);
  writeFileSync(path, "{not json");
  expect(readCredentials(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ token: "rrm_only" }));
  expect(readCredentials(path)).toBeNull();
});

test("doesn't read credentials saved for a plain-http gateway other than localhost", () => {
  const path = credentialsPath(tempHome());
  writeCredentials({ ...credentials, server: "http://relayrunner.example" }, path);
  expect(readCredentials(path)).toBeNull();
  writeCredentials({ ...credentials, server: "http://localhost:8787" }, path);
  expect(readCredentials(path)).toMatchObject({ server: "http://localhost:8787" });
});

test("saves a rotated token only for the same sign-in", () => {
  const path = credentialsPath(tempHome());
  expect(() => saveRotatedToken(credentials, "rrm_next", path)).toThrow(/removed/);

  writeCredentials(credentials, path);
  saveRotatedToken(credentials, "rrm_next", path);
  expect(readCredentials(path)).toEqual({ ...credentials, token: "rrm_next" });

  // `relayrunner login` enrolled another machine meanwhile: leave it alone.
  const other = { ...credentials, machine: { id: "m2", name: "desktop" }, token: "rrm_other" };
  writeCredentials(other, path);
  expect(() => saveRotatedToken(credentials, "rrm_late", path)).toThrow(/another sign-in/);
  expect(readCredentials(path)).toEqual(other);
});

test("retries once with the file's token when a rotation made the one it read stale", async () => {
  const path = credentialsPath(tempHome());
  writeCredentials({ ...credentials, token: "rrm_rotated" }, path);
  const call = async (token: string) => ({ status: token === "rrm_rotated" ? "ok" : "revoked" });
  expect(await withCurrentToken(credentials, call, path)).toEqual({ status: "ok" });

  // Nothing changed on disk: the rejection stands, with no second call.
  writeCredentials(credentials, path);
  let calls = 0;
  const counted = async () => ({ status: (calls++, "revoked") });
  expect(await withCurrentToken(credentials, counted, path)).toEqual({ status: "revoked" });
  expect(calls).toBe(1);
});
