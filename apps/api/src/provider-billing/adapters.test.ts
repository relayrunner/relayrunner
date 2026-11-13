import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { depot } from "./depot.ts";
import { connectStream, envelope, namespace } from "./namespace.ts";
import { type AdapterContext, ProviderApiError, ProviderAuthError } from "./types.ts";
import { warpbuild } from "./warpbuild.ts";

// The fixtures follow each provider's published schema (Depot's OpenAPI spec, Namespace's protos,
// WarpBuild's API reference). None is a captured response yet: check them against a real account.
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A fetch that answers each call with the next response, and records what it was asked. */
function fakeFetch(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call to ${String(input)}`);
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetcher, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ctx = (fetcher: typeof fetch, options: Record<string, string> = {}): AdapterContext => ({
  token: "tok_secret",
  options,
  fetch: fetcher,
});

const window = { start: new Date("2026-11-12T00:00:00Z"), end: new Date("2026-11-13T00:00:00Z") };

describe("Depot", () => {
  test("verify lists connections with the token as a bearer and names the GitHub account", async () => {
    const { fetcher, calls } = fakeFetch([json(fixture("depot-connections.json"))]);
    expect(await depot.verify(ctx(fetcher))).toEqual({ accountName: "acme" });
    expect(calls[0]!.url).toBe(
      "https://api.depot.dev/depot.core.v1.GithubActionsService/ListGithubActionsConnections",
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok_secret");
    expect(calls[0]!.headers.get("connect-protocol-version")).toBe("1");
  });

  test("usage pages through finished jobs in the window", async () => {
    const { fetcher, calls } = fakeFetch([
      json(fixture("depot-jobs-page-1.json")),
      json(fixture("depot-jobs-page-2.json")),
    ]);
    const usage = await depot.usage(ctx(fetcher), window);
    expect(calls.map((call) => call.body)).toEqual([
      {
        timeRange: { startAt: "2026-11-12T00:00:00.000Z", endAt: "2026-11-13T00:00:00.000Z" },
        statuses: ["GITHUB_ACTIONS_JOB_STATUS_FINISHED"],
        pageSize: 250,
      },
      expect.objectContaining({ pageToken: "page-2" }),
    ]);
    expect(usage.days).toEqual([]);
    // The job without a GitHub id is left out.
    expect(usage.jobs).toEqual([
      {
        jobId: "41000000001",
        runId: "18000000001",
        repository: "acme/widgets",
        jobName: "test (ubuntu)",
        runnerLabel: "depot-ubuntu-24.04-4",
        startedAt: new Date("2026-11-12T10:00:04Z"),
        finishedAt: new Date("2026-11-12T10:03:10Z"),
        billableSeconds: 186,
        queueSeconds: 4,
        costUsd: null,
      },
      expect.objectContaining({ jobId: "41000000002", billableSeconds: 38, queueSeconds: 2 }),
    ]);
  });

  test("a refused token is a ProviderAuthError; other failures are ProviderApiError", async () => {
    const refused = fakeFetch([json({ code: "unauthenticated" }, 401)]);
    await expect(depot.verify(ctx(refused.fetcher))).rejects.toBeInstanceOf(ProviderAuthError);
    const down = fakeFetch([new Response("bad gateway", { status: 502 })]);
    await expect(depot.verify(ctx(down.fetcher))).rejects.toBeInstanceOf(ProviderApiError);
  });
});

/** A Connect server-stream body: each message enveloped, then the end message. */
function streamBody(messages: unknown[], end: unknown = {}) {
  const parts = [
    ...messages.map((m) => envelope(0, new TextEncoder().encode(JSON.stringify(m)))),
    envelope(2, new TextEncoder().encode(JSON.stringify(end))),
  ];
  return new Blob(parts);
}

describe("Namespace", () => {
  test("verify reads today's usage from the region's Compute endpoint", async () => {
    const { fetcher, calls } = fakeFetch([json({ perDay: [] })]);
    expect(await namespace.verify(ctx(fetcher, { region: "eu" }))).toEqual({ accountName: null });
    expect(calls[0]!.url).toBe(
      "https://eu.compute.namespaceapis.com/namespace.cloud.compute.v1beta.UsageService/GetUsage",
    );
  });

  test("an unknown region falls back to us", async () => {
    const { fetcher, calls } = fakeFetch([json({ perDay: [] })]);
    await namespace.verify(ctx(fetcher, { region: "mars" }));
    expect(new URL(calls[0]!.url).host).toBe("us.compute.namespaceapis.com");
  });

  test("usage reads unit minutes per day and each instance's GitHub job", async () => {
    const { fetcher, calls } = fakeFetch([
      json(fixture("namespace-usage.json")),
      new Response(streamBody(fixture("namespace-report.json") as unknown[])),
    ]);
    const usage = await namespace.usage(ctx(fetcher, { region: "us" }), window);

    expect(calls[0]!.body).toEqual({
      periodStart: { year: 2026, month: 11, day: 12 },
      periodEnd: { year: 2026, month: 11, day: 13 },
    });
    expect(calls[1]!.headers.get("content-type")).toBe("application/connect+json");

    expect(usage.days).toContainEqual({
      day: new Date("2026-11-11T00:00:00Z"),
      unit: "unit_minutes",
      quantity: 1040,
      costUsd: null,
    });
    expect(usage.days).toContainEqual({
      day: new Date("2026-11-12T00:00:00Z"),
      unit: "wall_minutes",
      quantity: 120,
      costUsd: null,
    });
    // The builder instance served no GitHub job.
    expect(usage.jobs).toEqual([
      {
        jobId: "42000000001",
        runId: "19000000001",
        repository: "acme/widgets",
        jobName: "build",
        runnerLabel: "namespace-profile-default",
        startedAt: new Date("2026-11-12T10:00:00Z"),
        finishedAt: new Date("2026-11-12T10:04:50Z"),
        // The instance ran from 09:59:55 to 10:05:00.
        billableSeconds: 305,
        queueSeconds: 20,
        costUsd: null,
      },
      expect.objectContaining({ jobId: "42000000002", billableSeconds: 120, queueSeconds: 7 }),
    ]);
  });

  test("an error in the stream's end message is thrown, refused tokens as ProviderAuthError", async () => {
    const refused = fakeFetch([
      new Response(streamBody([], { error: { code: "unauthenticated", message: "bad token" } })),
    ]);
    await expect(
      connectStream(ctx(refused.fetcher), "https://us.compute.namespaceapis.com/x", {}),
    ).rejects.toBeInstanceOf(ProviderAuthError);

    const cut = fakeFetch([new Response(envelope(0, new TextEncoder().encode("{}")))]);
    await expect(
      connectStream(ctx(cut.fetcher), "https://us.compute.namespaceapis.com/x", {}),
    ).rejects.toThrow("ended without an end message");
  });
});

describe("WarpBuild", () => {
  test("verify reads a day of the CI billing report", async () => {
    const { fetcher, calls } = fakeFetch([json(fixture("warpbuild-billing.json"))]);
    expect(await warpbuild.verify(ctx(fetcher))).toEqual({ accountName: null });
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.warpbuild.com/api/v1/reports/billing/ci");
    expect(url.searchParams.get("per_page")).toBe("1");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok_secret");
  });

  test("usage pages through billed jobs and keeps the daily chart", async () => {
    const { fetcher, calls } = fakeFetch([
      json(fixture("warpbuild-billing.json")),
      json(fixture("warpbuild-billing-page-2.json")),
    ]);
    const usage = await warpbuild.usage(ctx(fetcher), window);
    expect(calls.map((call) => new URL(call.url).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(new URL(calls[0]!.url).searchParams.get("start_date")).toBe("2026-11-12T00:00:00.000Z");
    expect(usage.jobs).toEqual([
      {
        jobId: "43000000001",
        runId: "20000000001",
        repository: "acme/widgets",
        jobName: "build",
        runnerLabel: "warp-ubuntu-latest-x64-4x",
        startedAt: null,
        finishedAt: new Date("2026-11-12T10:00:00Z"),
        billableSeconds: 240,
        queueSeconds: null,
        costUsd: 0.032,
      },
      expect.objectContaining({ jobId: "43000000002", costUsd: 0.008 }),
    ]);
    expect(usage.days).toEqual([
      { day: new Date("2026-11-11T00:00:00Z"), unit: "jobs", quantity: 3, costUsd: 0.12 },
      { day: new Date("2026-11-12T00:00:00Z"), unit: "jobs", quantity: 2, costUsd: 0.06 },
    ]);
  });

  test("a refused key is a ProviderAuthError", async () => {
    const { fetcher } = fakeFetch([json({ error: "invalid api key" }, 401)]);
    await expect(warpbuild.verify(ctx(fetcher))).rejects.toBeInstanceOf(ProviderAuthError);
  });
});
