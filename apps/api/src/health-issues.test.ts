import { expect, test } from "vitest";
import { createDb } from "./db/index.ts";
import {
  alertText,
  recordFailure,
  recordSuccess,
  runCronTasks,
  takeHealthAlerts,
} from "./health-issues.ts";
import { createTestEnv } from "./testing.ts";

const HOUR = 60 * 60_000;
const at = (hours: number) => new Date(Date.UTC(2026, 10, 20) + hours * HOUR);

test("a cron task alerts on its third failure in a row, daily while open, and once when it clears", async () => {
  const db = createDb((await createTestEnv()).DB);
  const fail = (hour: number) =>
    recordFailure(
      db,
      { key: "cron:sync", kind: "cron", error: new Error("Status 403.") },
      at(hour),
    );
  await fail(0);
  await fail(1);
  expect(await takeHealthAlerts(db, at(1))).toEqual([]);
  await fail(2);
  const [alert] = await takeHealthAlerts(db, at(2));
  expect(alert).toMatchObject({ key: "cron:sync", state: "failing", failures: 3, since: at(0) });
  expect(alertText(alert!)).toContain("failed 3 times in a row");
  // Told already: quiet until a day has passed.
  await fail(3);
  expect(await takeHealthAlerts(db, at(3))).toEqual([]);
  await fail(27);
  expect(await takeHealthAlerts(db, at(27))).toMatchObject([{ failures: 5 }]);
  await recordSuccess(db, "cron:sync", at(28));
  expect(await takeHealthAlerts(db, at(28))).toMatchObject([{ state: "cleared" }]);
  // Cleared and told: gone.
  expect(await takeHealthAlerts(db, at(29))).toEqual([]);
});

test("a failure that clears before its threshold stays quiet and starts over", async () => {
  const db = createDb((await createTestEnv()).DB);
  const fail = (hour: number) =>
    recordFailure(db, { key: "task:signals:1", kind: "task", error: "boom" }, at(hour));
  for (const hour of [0, 0, 1]) await fail(hour);
  await recordSuccess(db, "task:signals:1", at(2));
  await fail(3);
  expect(await takeHealthAlerts(db, at(3))).toEqual([]);
  for (const hour of [3, 4, 4]) await fail(hour);
  expect(await takeHealthAlerts(db, at(4))).toMatchObject([{ failures: 4, since: at(3) }]);
});

test("cron tasks each record their own outcome and the first failure still throws", async () => {
  const db = createDb((await createTestEnv()).DB);
  let ran = 0;
  const tasks = {
    good: async () => ran++,
    bad: async () => {
      throw new Error("nope");
    },
  };
  for (let run = 0; run < 3; run++) await expect(runCronTasks(db, tasks)).rejects.toThrow("nope");
  expect(ran).toBe(3);
  expect(await takeHealthAlerts(db)).toMatchObject([{ key: "cron:bad", error: "nope" }]);
});
