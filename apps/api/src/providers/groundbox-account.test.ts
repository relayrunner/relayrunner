import { describe, expect, test } from "vitest";
import {
  groundboxHeld,
  groundboxMinutes,
  groundboxMinutesView,
  type GroundboxReading,
} from "./groundbox-account.ts";
import type { GroundboxAccount } from "../provider-billing/groundbox.ts";

const account = (changes: Partial<GroundboxAccount> = {}): GroundboxReading => ({
  ok: true,
  readAt: Date.parse("2026-11-21T12:00:00Z"),
  account: {
    team: "acme",
    plan: "free",
    status: "active",
    freeMinutes: { included: 3000, used: 1200, left: 1800, periodStart: "2026-11-01T00:00:00Z" },
    balanceUsd: 5,
    ciSpentUsd: 0,
    caps: { dailyUsd: null, spentTodayUsd: 0, monthlyUsd: null, spentThisMonthUsd: 0 },
    ...changes,
  },
});

describe("groundboxMinutes", () => {
  test("is Groundbox's own count, with no runway to leave", () => {
    expect(groundboxMinutes(account())).toEqual({
      status: "ok",
      accountLogin: "acme",
      quotaMinutes: 3000,
      usedMinutes: 1200,
      burnRatePerHour: null,
    });
  });

  test("never blocks without a reading or free minutes", () => {
    expect(groundboxMinutes(null)).toBeNull();
    expect(groundboxMinutes({ ok: false, reason: "read_failed" })).toBeNull();
    expect(groundboxMinutes(account({ freeMinutes: null }))).toBeNull();
  });
});

describe("groundboxHeld", () => {
  test("runs jobs on an active account with room", () => {
    expect(groundboxHeld(account())).toBeNull();
    expect(groundboxHeld({ ok: false, reason: "not_connected" })).toBeNull();
  });

  test("a held or suspended account", () => {
    expect(groundboxHeld(account({ status: "held" }))).toEqual({ reason: "account_held" });
    expect(groundboxHeld(account({ status: "suspended" }))).toEqual({
      reason: "account_suspended",
    });
  });

  test("at a daily or monthly spend cap set in Groundbox", () => {
    const caps = { dailyUsd: 2, spentTodayUsd: 2, monthlyUsd: null, spentThisMonthUsd: 9 };
    expect(groundboxHeld(account({ caps }))).toEqual({ reason: "spend_cap" });
    const monthly = { dailyUsd: null, spentTodayUsd: 1, monthlyUsd: 20, spentThisMonthUsd: 19.5 };
    expect(groundboxHeld(account({ caps: monthly }))).toBeNull();
    expect(groundboxHeld(account({ caps: { ...monthly, spentThisMonthUsd: 20 } }))).toEqual({
      reason: "spend_cap",
    });
  });

  test("Free with no free minutes and no credit left", () => {
    const out = { included: 3000, used: 3000, left: 0, periodStart: null };
    expect(groundboxHeld(account({ freeMinutes: out, balanceUsd: 0 }))).toEqual({
      reason: "out_of_credit",
    });
    // Credit left still pays for jobs, and a paid plan bills past them.
    expect(groundboxHeld(account({ freeMinutes: out, balanceUsd: 1.2 }))).toBeNull();
    expect(groundboxHeld(account({ freeMinutes: out, balanceUsd: 0, plan: "monthly" }))).toBeNull();
  });
});

describe("groundboxMinutesView", () => {
  test("says why the minutes can't be counted", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(groundboxMinutesView({ ok: false, reason: "not_connected" }, now)).toMatchObject({
      status: "not_available",
      reason: "not_connected",
      quotaMinutes: 3000,
      cycleStart: "2026-11-01T00:00:00.000Z",
    });
    const sponsored = account({ plan: "sponsored", freeMinutes: null, balanceUsd: 50 });
    expect(groundboxMinutesView(sponsored, now)).toMatchObject({
      status: "not_available",
      reason: "no_free_minutes",
      accountLogin: "acme",
      plan: "sponsored",
      balanceUsd: 50,
    });
  });

  test("a reading's count, read time and hold", () => {
    expect(groundboxMinutesView(account({ status: "held" }))).toEqual({
      status: "ok",
      reason: null,
      accountLogin: "acme",
      quotaMinutes: 3000,
      usedMinutes: 1200,
      burnRatePerHour: null,
      cycleStart: "2026-11-01T00:00:00Z",
      syncedAt: "2026-11-21T12:00:00.000Z",
      held: "account_held",
      ciSpentUsd: 0,
      plan: "free",
      balanceUsd: 5,
    });
  });
});
