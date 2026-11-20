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

test("a cron task alerts on its third failure, reminds twice over a week, and once when it clears", async () => {
  const { db, fail, pass } = await setup("cron:sync", "cron");
  await fail(0, new Error("Status 403."));
  await fail(1, new Error("Status 403."));
  expect(await takeHealthAlerts(db, at(1))).toEqual([]);
  await fail(2, new Error("Status 403."));
  const [alert] = await takeHealthAlerts(db, at(2));
  expect(alert).toMatchObject({ key: "cron:sync", state: "failing", reminder: false, failures: 3 });
  expect(alertLine(alert!)).toBe(
    `cron:sync failed 3 times in a row since ${at(0).toISOString()}: Status 403.`,
  );
  // First reminder 2 days on, the last 4 days after that, then nothing however long it stays broken.
  await fail(3);
  expect(await takeHealthAlerts(db, at(49))).toEqual([]);
  const [reminder] = await takeHealthAlerts(db, at(50));
  expect(reminder).toMatchObject({ reminder: true, failures: 4 });
  expect(alertLine(reminder!)).toMatch(/^Still broken: cron:sync failed 4 times/);
  expect(await takeHealthAlerts(db, at(50 + 95))).toEqual([]);
  expect(await takeHealthAlerts(db, at(50 + 96))).toMatchObject([{ reminder: true }]);
  await fail(200);
  expect(await takeHealthAlerts(db, at(1000))).toEqual([]);
  await pass(1001);
  expect(await takeHealthAlerts(db, at(1001))).toMatchObject([{ state: "cleared" }]);
  // Cleared and told: gone.
  expect(await takeHealthAlerts(db, at(1002))).toEqual([]);
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

test("an integration is told at once, and from the start again if it breaks after clearing", async () => {
  const { db, fail, pass } = await setup("integration:app-suspended:w", "integration");
  await fail(0, "the App is suspended on GitHub");
  expect(await takeHealthAlerts(db, at(0))).toMatchObject([{ state: "failing" }]);
  expect(await takeHealthAlerts(db, at(48))).toMatchObject([{ reminder: true }]);
  // Cleared and broken again before the cron told it cleared: a new run, told as new.
  await pass(49);
  await fail(49);
  expect(await takeHealthAlerts(db, at(49))).toMatchObject([
    { state: "failing", reminder: false, failures: 1 },
  ]);
});

test("cron tasks each record their own outcome and the first failure still throws", async () => {
  const db = createDb((await createTestEnv()).DB);
  for (let run = 0; run < 3; run++)
    await expect(
      runCronTasks(db, { good: Promise.resolve(), bad: Promise.reject(new Error("nope")) }),
    ).rejects.toThrow("nope");
  expect(await takeHealthAlerts(db)).toMatchObject([{ key: "cron:bad", error: "nope" }]);
});
