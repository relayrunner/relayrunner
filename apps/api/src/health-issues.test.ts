import { expect, test } from "vitest";
import { createDb } from "./db/index.ts";
import {
  alertLine,
  type HealthIssueKind,
  recordOutcomes,
  runCronTasks,
  takeHealthAlerts,
} from "./health-issues.ts";
import { createTestEnv } from "./testing.ts";

const HOUR = 60 * 60_000;
const at = (hours: number) => new Date(Date.UTC(2026, 10, 20) + hours * HOUR);

async function setup(key: string, kind: HealthIssueKind) {
  const db = createDb((await createTestEnv()).DB);
  return {
    db,
    fail: (hour: number, error: unknown = "boom") =>
      recordOutcomes(db, [{ key, kind, error }], at(hour)),
    pass: (hour: number) => recordOutcomes(db, [{ key, kind }], at(hour)),
  };
}

test("a cron task alerts on its third failure in a row, daily while open, and once when it clears", async () => {
  const { db, fail, pass } = await setup("cron:sync", "cron");
  await fail(0, new Error("Status 403."));
  await fail(1, new Error("Status 403."));
  expect(await takeHealthAlerts(db, at(1))).toEqual([]);
  await fail(2, new Error("Status 403."));
  const [alert] = await takeHealthAlerts(db, at(2));
  expect(alert).toMatchObject({ key: "cron:sync", state: "failing", failures: 3, since: at(0) });
  expect(alertLine(alert!)).toBe(
    `cron:sync failed 3 times in a row since ${at(0).toISOString()}: Status 403.`,
  );
  // Told already: quiet until a day has passed.
  await fail(3);
  expect(await takeHealthAlerts(db, at(3))).toEqual([]);
  await fail(27);
  expect(await takeHealthAlerts(db, at(27))).toMatchObject([{ failures: 5 }]);
  await pass(28);
  expect(await takeHealthAlerts(db, at(28))).toMatchObject([{ state: "cleared" }]);
  // Cleared and told: gone.
  expect(await takeHealthAlerts(db, at(29))).toEqual([]);
});

test("a failure that clears before its threshold stays quiet and starts over", async () => {
  const { db, fail, pass } = await setup("task:signals:1", "task");
  for (const hour of [0, 0, 1]) await fail(hour);
  await pass(2);
  await fail(3);
  expect(await takeHealthAlerts(db, at(3))).toEqual([]);
  for (const hour of [3, 4, 4]) await fail(hour);
  expect(await takeHealthAlerts(db, at(4))).toMatchObject([{ failures: 4, since: at(3) }]);
});

test("an integration is told once, and again if it breaks after clearing", async () => {
  const { db, fail, pass } = await setup("integration:app-suspended:w", "integration");
  await fail(0, "the App is suspended on GitHub");
  expect(await takeHealthAlerts(db, at(0))).toMatchObject([{ state: "failing" }]);
  await fail(30);
  expect(await takeHealthAlerts(db, at(30))).toEqual([]);
  // Cleared and broken again before the cron told it cleared: a new run, told again.
  await pass(31);
  await fail(31);
  expect(await takeHealthAlerts(db, at(31))).toMatchObject([{ state: "failing", failures: 1 }]);
});

test("cron tasks each record their own outcome and the first failure still throws", async () => {
  const db = createDb((await createTestEnv()).DB);
  for (let run = 0; run < 3; run++)
    await expect(
      runCronTasks(db, { good: Promise.resolve(), bad: Promise.reject(new Error("nope")) }),
    ).rejects.toThrow("nope");
  expect(await takeHealthAlerts(db)).toMatchObject([{ key: "cron:bad", error: "nope" }]);
});
