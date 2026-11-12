import { PRICE_SOURCES, type PriceSource } from "@relayrunner/providers";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "./env.ts";
import { checkPrices } from "./price-check.ts";
import { createDb } from "./db/index.ts";
import { forgetPriceBook, readPriceBook } from "./prices.ts";
import * as testing from "./testing.ts";

const source = (provider: string) => PRICE_SOURCES.find((s) => s.provider === provider)!;

// Trimmed copies of each page, at the prices in BASE_PRICES.
const PAGES: Record<string, string> = {
  blacksmith: [
    '<span id="base-price" class="architecture_pricing">$0.004</span>',
    '<span id="arm-price" class="architecture_pricing">$0.0025</span>',
    '<span id="win-price" class="architecture_pricing">$0.008</span>',
    '<span id="mac-price" class="architecture_pricing">$0.08</span>',
  ].join("\n"),
  depot: [
    "| Label | CPUs | Memory | Disk | Cache | Price per minute | Multiplier |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| `depot-ubuntu-24.04`    | 2    | 8 GB   | 100 GB    | 2GB | $0.006 | 1x |",
    "| `depot-ubuntu-24.04-4`  | 4    | 16 GB  | 130 GB    | 4GB | $0.012 | 2x |",
    "| `depot-ubuntu-24.04-arm` | 2   | 8 GB   | 100 GB    | 2GB | $0.006 | 1x |",
    "| `depot-windows-2025`    | 2    | 8 GB   | 100 GB    | $0.008 | 2x |",
    "| `depot-macos-15`        | 8    | 24 GB  | 400 GB    | 2 GB | $0.08 |",
  ].join("\n"),
  warpbuild: JSON.stringify({
    runners: [
      {
        runner_type: "warp-ubuntu-latest-x64-4x",
        per_minute_usd: 0.008,
        platform: "linux-x64",
        vcpu: 4,
      },
      {
        runner_type: "warp-ubuntu-latest-x64-2x",
        per_minute_usd: 0.004,
        platform: "linux-x64",
        vcpu: 2,
      },
      {
        runner_type: "warp-ubuntu-latest-arm64-2x",
        per_minute_usd: 0.003,
        platform: "linux-arm64",
        vcpu: 2,
      },
      {
        runner_type: "warp-ubuntu-2604-arm64-6x-xfast",
        per_minute_usd: 0.08,
        platform: "linux-arm64",
        vcpu: 6,
      },
      {
        runner_type: "warp-windows-latest-x64-4x",
        per_minute_usd: 0.016,
        platform: "windows",
        vcpu: 4,
      },
      {
        runner_type: "warp-macos-latest-arm64-6x",
        per_minute_usd: 0.08,
        platform: "macos",
        vcpu: 6,
      },
    ],
  }),
  ubicloud: [
    "- { id: a, resource_type: GitHubRunnerMinutes, resource_family: standard-2, location: global, unit_price: 0.0012500000, billed_by: amount, active_from: 2026-09-01T00:00:00Z, byoc: false }",
    "- { id: b, resource_type: GitHubRunnerMinutes, resource_family: standard-2-arm, location: global, unit_price: 0.0012500000, billed_by: amount, active_from: 2026-09-01T00:00:00Z, byoc: false }",
    "- { id: c, resource_type: GitHubRunnerMinutes, resource_family: premium-2, location: global, unit_price: 0.0020000000, billed_by: amount, active_from: 2026-09-01T00:00:00Z, byoc: false }",
    "- { id: d, resource_type: GitHubRunnerMinutes, resource_family: standard-2, location: global, unit_price: 0.0008000000, billed_by: amount, active_from: 2023-01-01T00:00:00Z, byoc: false }",
    "- { id: e, resource_type: GitHubRunnerMinutes, resource_family: standard-2, location: global, unit_price: 0.0010000000, billed_by: amount, active_from: 2026-05-01T00:00:00Z, byoc: false }",
    "- { id: f, resource_type: GitHubRunnerMinutes, resource_family: premium-2, location: global, unit_price: 0.0016000000, billed_by: amount, active_from: 2025-05-01T00:00:00Z, byoc: false }",
    "- { id: g, resource_type: GitHubRunnerMinutes, resource_family: standard-2, location: global, unit_price: 0.0050000000, billed_by: amount, active_from: 2026-09-01T00:00:00Z, byoc: true }",
  ].join("\n"),
  github: [
    "| Operating system | SKU | Per-minute rate (USD) |",
    "| --- | --- | --- |",
    "| Linux 1-core (x64)     | `actions_linux_slim`  | $0.002 |",
    "| Linux 2-core (x64)     | `actions_linux`       | $0.006 |",
    "| Linux 2-core (arm64)   | `actions_linux_arm`   | $0.005 |",
    "| Windows 2-core (x64)   | `actions_windows`     | $0.010 |",
    "| Windows 2-core (arm64) | `actions_windows_arm` | $0.010 |",
    "| macOS 3-core or 4-core | `actions_macos`       | $0.062 |",
  ].join("\n"),
};

describe("price sources", () => {
  test("read the prices off each page", () => {
    expect(source("blacksmith").parse(PAGES.blacksmith!)).toEqual([
      { rate: "linux", usd: 0.002 },
      { rate: "arm", usd: 0.00125 },
      { rate: "windows", usd: 0.004 },
      { rate: "macos", usd: 0.08 / 6 },
    ]);
    expect(source("depot").parse(PAGES.depot!)).toEqual([
      { rate: "linux", usd: 0.003 },
      { rate: "arm", usd: 0.003 },
      { rate: "windows", usd: 0.004 },
      { rate: "macos", usd: 0.01 },
    ]);
    expect(source("warpbuild").parse(PAGES.warpbuild!)).toEqual([
      { rate: "linux", usd: 0.002 },
      { rate: "arm", usd: 0.0015 },
      { rate: "windows", usd: 0.004 },
      { rate: "macos", usd: 0.08 / 6 },
    ]);
    expect(source("ubicloud").parse(PAGES.ubicloud!)).toEqual([
      { rate: "standard", usd: 0.000625, from: "2026-09-01" },
      { rate: "premium", usd: 0.001, from: "2026-09-01" },
      { rate: "standard", usd: 0.0004, from: "2023-01-01" },
      { rate: "standard", usd: 0.0005, from: "2026-05-01" },
      { rate: "premium", usd: 0.0008, from: "2025-05-01" },
    ]);
    expect(source("github").parse(PAGES.github!)).toContainEqual({
      rate: "linux-2-core",
      usd: 0.006,
    });
  });

  test("throw when a page no longer looks as expected", () => {
    for (const s of PRICE_SOURCES)
      expect(() => s.parse("<html>Pricing</html>"), s.provider).toThrow();
  });
});

describe("checkPrices", () => {
  let env: Env;
  const send = vi.fn();

  beforeAll(async () => {
    env = {
      ...(await testing.createTestEnv()),
      OPERATOR_ALERT_EMAIL: "ops@example.com",
      EMAIL: { send } as unknown as SendEmail,
    };
  });

  beforeEach(async () => {
    send.mockReset();
    forgetPriceBook();
    await env.DB.prepare("delete from price_finding").run();
    await env.DB.prepare("delete from price_check").run();
  });

  const fetcher =
    (pages: Record<string, string | null>) =>
    async (url: RequestInfo | URL): Promise<Response> => {
      const s = PRICE_SOURCES.find((s: PriceSource) => s.url === String(url))!;
      const page = pages[s.provider];
      return page == null ? new Response("gone", { status: 404 }) : new Response(page);
    };

  const now = new Date("2026-11-20T06:00:00Z");
  const pendingRows = async () =>
    (
      await env.DB.prepare(
        'select provider, rate, usd, effective_from as "from" from price_finding order by provider, rate',
      ).all()
    ).results;

  test("records nothing when every price matches", async () => {
    const results = await checkPrices(env, now, fetcher(PAGES));
    expect(results.every((r) => r.error === null && r.found.length === 0)).toBe(true);
    expect(await pendingRows()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  test("holds a changed price for approval and emails once", async () => {
    const changed = {
      ...PAGES,
      depot: PAGES.depot!.replace("| $0.006 | 1x |", "| $0.007 | 1x |"),
    };
    await checkPrices(env, now, fetcher(changed));
    expect(await pendingRows()).toEqual([
      { provider: "depot", rate: "linux", usd: 0.0035, from: "2026-11-20" },
    ]);
    // Findings don't price jobs.
    expect((await readPriceBook(createDb(env.DB))).usd("depot", "linux", now.getTime())).toBe(
      0.003,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].subject).toBe("[prices] 1 price changed");

    // The next day the same price is already waiting.
    await checkPrices(env, new Date("2026-11-21T06:00:00Z"), fetcher(changed));
    expect(await pendingRows()).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("doesn't raise a dismissed price again", async () => {
    const changed = { ...PAGES, github: PAGES.github!.replace("$0.062", "$0.07") };
    await checkPrices(env, now, fetcher(changed));
    await env.DB.prepare("update price_finding set dismissed_at = 1").run();
    const [github] = await checkPrices(
      env,
      new Date("2026-11-21T06:00:00Z"),
      fetcher(changed),
    ).then((results) => results.filter((r) => r.provider === "github"));
    expect(github!.found).toEqual([]);
  });

  test("records a new dated price on its own day", async () => {
    const changed = {
      ...PAGES,
      ubicloud: `${PAGES.ubicloud}\n- { id: h, resource_type: GitHubRunnerMinutes, resource_family: premium-2, location: global, unit_price: 0.0030000000, billed_by: amount, active_from: 2026-12-01T00:00:00Z, byoc: false }`,
    };
    await checkPrices(env, now, fetcher(changed));
    expect(await pendingRows()).toEqual([
      { provider: "ubicloud", rate: "premium", usd: 0.0015, from: "2026-12-01" },
    ]);
  });

  test("notes a page that stops reading, emailing only the first time", async () => {
    const broken = { ...PAGES, blacksmith: null };
    const results = await checkPrices(env, now, fetcher(broken));
    expect(results.find((r) => r.provider === "blacksmith")!.error).toBe("answered 404");
    const check = await env.DB.prepare(
      "select error from price_check where provider = 'blacksmith'",
    ).first();
    expect(check).toEqual({ error: "answered 404" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].subject).toBe("[prices] A price page stopped reading");

    await checkPrices(env, new Date("2026-11-21T06:00:00Z"), fetcher(broken));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
