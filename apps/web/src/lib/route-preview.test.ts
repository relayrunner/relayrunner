import { describe, expect, test } from "vitest";
import type { AccountUsage } from "./actions-usage.ts";
import { sampleRouterAccounts } from "./router-sample.ts";
import type { Machine } from "./machines.ts";
import { previewRoute } from "./route-preview.ts";

const machine = (
  name: string,
  status: Machine["status"],
  extra: Partial<Machine> = {},
): Machine => ({
  id: name,
  name,
  os: "macos",
  arch: "arm64",
  lastSeenAt: null,
  revokedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  status,
  ...extra,
});
const idle = { online: true, state: "idle" as const, connectedAt: 0 };
const busy = { online: true, state: "busy" as const, connectedAt: 0 };
const offline = { online: false, state: null, connectedAt: null };

const used = (usedMinutes: number): AccountUsage[] =>
  sampleRouterAccounts("team").map((account) => ({ ...account, usedMinutes }));

describe("previewRoute", () => {
  test("an idle machine takes the job ahead of GitHub", () => {
    const preview = previewRoute(
      [{ key: "machine" }, { key: "github" }],
      [machine("mbp", idle)],
      [],
    );
    expect(preview.next).toEqual({ title: "Self-hosted · mbp", why: "mbp is idle" });
    expect(preview.steps.map((step) => step.state)).toEqual(["next", "unreached"]);
  });

  test("a busy or offline machine passes the job to GitHub, saying why", () => {
    expect(
      previewRoute([{ key: "machine" }, { key: "github" }], [machine("mbp", busy)], []).next,
    ).toEqual({ title: "GitHub-hosted", why: "mbp is busy with a job" });
    expect(
      previewRoute([{ key: "machine" }, { key: "github" }], [machine("mbp", offline)], []).next
        ?.why,
    ).toBe("mbp is offline");
    expect(
      previewRoute(
        [{ key: "machine" }, { key: "github" }],
        [machine("mbp", idle, { paused: { at: "", by: null } })],
        [],
      ).next?.why,
    ).toBe("mbp is paused");
  });

  test("a limited GitHub step passes the job on past its limit", () => {
    const steps = [
      { key: "github" as const, limit: { percent: 80 } },
      { key: "machine" as const },
      { key: "github" as const },
    ];
    expect(previewRoute(steps, [machine("mini", idle)], used(1500)).next?.title).toBe(
      "GitHub-hosted",
    );
    const past = previewRoute(steps, [machine("mini", idle)], used(2520));
    expect(past.next).toEqual({
      title: "Self-hosted · mini",
      why: "Used 84% of included minutes, past the 80% limit",
    });
    const allBusy = previewRoute(steps, [machine("mini", busy)], used(2520));
    expect(allBusy.next?.title).toBe("GitHub-hosted");
    expect(allBusy.steps.map((step) => step.state)).toEqual(["skipped", "skipped", "next"]);
  });

  test("a limit with no quota to check never blocks", () => {
    const preview = previewRoute(
      [{ key: "github", limit: { percent: 80 } }],
      [],
      sampleRouterAccounts("enterprise"),
    );
    expect(preview.next?.title).toBe("GitHub-hosted");
  });

  test("nothing takes the job when every step passes it on", () => {
    expect(previewRoute([{ key: "machine" }], [], []).next).toBeNull();
  });
});
