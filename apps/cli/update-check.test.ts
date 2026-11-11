import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CHECK_INTERVAL_MS, checkForUpdate, isNewer, updateNotice } from "./update-check.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "relayrunner-update-"));
  vi.stubEnv("RELAYRUNNER_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function registry(version: string) {
  return vi.fn(async () => Response.json({ name: "relayrunner", version }));
}

test("reports a newer version and caches it for a day", async () => {
  const fetch = registry("0.7.0");
  const now = 1_000_000;
  expect(await checkForUpdate({ now, current: "0.6.0", fetch })).toBe("0.7.0");
  expect(JSON.parse(readFileSync(join(home, "update-check.json"), "utf8"))).toEqual({
    checkedAt: now,
    latest: "0.7.0",
  });

  // Within the day the cache answers.
  expect(await checkForUpdate({ now: now + CHECK_INTERVAL_MS - 1, current: "0.6.0", fetch })).toBe(
    "0.7.0",
  );
  expect(fetch).toHaveBeenCalledTimes(1);

  // A day later it asks again.
  await checkForUpdate({ now: now + CHECK_INTERVAL_MS, current: "0.6.0", fetch });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("says nothing when current", async () => {
  expect(await checkForUpdate({ current: "0.7.0", fetch: registry("0.7.0") })).toBeNull();
});

test("says nothing when the registry fails", async () => {
  const offline = vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
  expect(await checkForUpdate({ current: "0.6.0", fetch: offline })).toBeNull();
  const down = vi.fn(async () => new Response("nope", { status: 503 }));
  expect(await checkForUpdate({ current: "0.6.0", fetch: down })).toBeNull();
});

test("keeps the last answer when a later check fails", async () => {
  await checkForUpdate({ now: 0, current: "0.6.0", fetch: registry("0.7.0") });
  const offline = vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
  expect(await checkForUpdate({ now: CHECK_INTERVAL_MS, current: "0.6.0", fetch: offline })).toBe(
    "0.7.0",
  );
});

test("compares plain releases only", () => {
  expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("1.0.0", "0.99.0")).toBe(true);
  expect(isNewer("0.6.0", "0.6.0")).toBe(false);
  expect(isNewer("0.5.9", "0.6.0")).toBe(false);
  expect(isNewer("0.7.0-beta.1", "0.6.0")).toBe(false);
  expect(isNewer("0.7.0", "0.7.0-beta.1")).toBe(false);
});

test("the notice names the update command for how the CLI runs", () => {
  expect(
    updateNotice("0.7.0", "0.6.0", "/Users/a/.npm/_npx/abc123/node_modules/.bin/relayrunner"),
  ).toBe(
    "relayrunner 0.7.0 is available (you have 0.6.0). Update with `npx relayrunner@latest connect`.",
  );
  expect(updateNotice("0.7.0", "0.6.0", "/usr/local/bin/relayrunner")).toBe(
    "relayrunner 0.7.0 is available (you have 0.6.0). Update with `npm install --global relayrunner@latest`.",
  );
});
