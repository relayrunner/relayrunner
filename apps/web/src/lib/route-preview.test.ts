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
    ).toEqual({ title: "GitHub-hosted", why: "mbp is full (1 of 1 running)" });
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

  test("a machine with a free slot takes the job while busy", () => {
    const steps = [{ key: "machine" as const }, { key: "github" as const }];
    const half = { ...busy, slots: 2, running: 1 };
    expect(previewRoute(steps, [machine("mbp", half)], []).next).toEqual({
      title: "Self-hosted · mbp",
      why: "mbp has a free runner (1 of 2 running)",
    });
    expect(
      previewRoute(steps, [machine("mbp", { ...idle, slots: 2, running: 0 })], []).next?.why,
    ).toBe("mbp is idle");
  });

  test("full machines pass the job on with the gateway's wording", () => {
    const steps = [{ key: "machine" as const }, { key: "github" as const }];
    const full = { ...busy, slots: 2, running: 2 };
    expect(previewRoute(steps, [machine("mbp", full)], []).next?.why).toBe(
      "mbp is full (2 of 2 running)",
    );
    expect(previewRoute(steps, [machine("mbp", full), machine("mini", busy)], []).next?.why).toBe(
      "every machine that fits is full (mbp 2 of 2, mini 1 of 1 running)",
    );
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

  test("steps from the machine step on are unknown until the machines load", () => {
    const steps = [
      { key: "github", limit: { percent: 80 } },
      { key: "machine" },
      { key: "github" },
    ] as const;
    const preview = previewRoute([...steps], null, used(2520));
    expect(preview.steps.map((step) => step.state)).toEqual(["skipped", "unknown", "unknown"]);
    expect(preview.next).toBeNull();
  });
});
