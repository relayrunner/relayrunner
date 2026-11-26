import { describe, expect, test } from "vitest";
import { readStatusPage } from "./routes/status.ts";

const NOW = Date.parse("2026-11-25T16:00:00Z");

const page = (state: string, reports: Record<string, unknown>[] = []) => ({
  data: { id: "273280", type: "status_page", attributes: { aggregate_state: state } },
  included: [
    { id: "1", type: "status_page_section", attributes: { name: "Job routing" } },
    ...reports.map((attributes, i) => ({ id: String(i), type: "status_report", attributes })),
  ],
});

describe("readStatusPage", () => {
  test("operational has no incident", () => {
    expect(readStatusPage(page("operational"), NOW)).toEqual({
      state: "operational",
      incident: null,
    });
  });

  test("degraded takes the newest open report's title", () => {
    const body = page("degraded", [
      { title: "Old outage", aggregate_state: "resolved", starts_at: "2026-11-20T10:00:00Z" },
      { title: "Slow webhooks", aggregate_state: "degraded", starts_at: "2026-11-25T14:00:00Z" },
      {
        title: "Delayed job routing",
        aggregate_state: "degraded",
        starts_at: "2026-11-25T15:30:00Z",
      },
    ]);
    expect(readStatusPage(body, NOW)).toEqual({
      state: "degraded",
      incident: "Delayed job routing",
    });
  });

  test("skips maintenance that hasn't started or has ended", () => {
    const body = page("maintenance", [
      {
        title: "Tomorrow",
        report_type: "maintenance",
        starts_at: "2026-11-26T10:00:00Z",
        ends_at: "2026-11-26T11:00:00Z",
      },
      {
        title: "Database maintenance",
        report_type: "maintenance",
        starts_at: "2026-11-25T15:45:00Z",
        ends_at: "2026-11-25T16:30:00Z",
      },
    ]);
    expect(readStatusPage(body, NOW).incident).toBe("Database maintenance");
  });

  test("an automatic incident with no report has no title", () => {
    expect(readStatusPage(page("downtime"), NOW)).toEqual({ state: "downtime", incident: null });
  });

  test("an unknown state reads as unknown", () => {
    expect(readStatusPage(page("something-new"), NOW).state).toBeNull();
  });
});
