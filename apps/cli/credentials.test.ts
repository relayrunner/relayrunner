import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
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
  workspace: { id: "w1", name: "Acme", slug: "acme" },
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
