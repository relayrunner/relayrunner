import { expect, test } from "vitest";
import { runnerUpdate } from "./runner-update.ts";

const DAY = 86_400_000;
const now = Date.parse("2026-11-15T12:00:00Z");
const runner = (updateBy: number | null, update: string | null = "2.331.0") => ({
  runner: {
    version: "2.330.0",
    update,
    updateBy: updateBy === null ? null : new Date(updateBy).toISOString(),
  },
});

test("a runner behind is a note, then urgent a week before GitHub's cutoff, then overdue", () => {
  expect(runnerUpdate(runner(now + 20 * DAY), now)).toMatchObject({
    latest: "2.331.0",
    urgent: false,
    overdue: false,
  });
  expect(runnerUpdate(runner(now + 3 * DAY), now)).toMatchObject({ urgent: true, overdue: false });
  expect(runnerUpdate(runner(now - DAY), now)).toMatchObject({ urgent: true, overdue: true });
});

test("nothing to say when it's up to date or doesn't report a version", () => {
  expect(runnerUpdate(runner(null, null), now)).toBeNull();
  expect(runnerUpdate({ runner: null }, now)).toBeNull();
  expect(runnerUpdate({}, now)).toBeNull();
});
