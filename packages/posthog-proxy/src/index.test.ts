import { describe, expect, test } from "vitest";
import { isPostHogPath, postHogUrl, proxyPostHog } from "./index.ts";

describe("posthog proxy", () => {
  test("matches /ingest and paths under it only", () => {
    expect(isPostHogPath("/ingest")).toBe(true);
    expect(isPostHogPath("/ingest/e/")).toBe(true);
    expect(isPostHogPath("/ingestion")).toBe(false);
    expect(isPostHogPath("/docs/ingest")).toBe(false);
  });

  test("sends events to the ingestion host and static files to the assets host", () => {
    expect(postHogUrl(new URL("https://relayrunner.app/ingest/e/?ip=0&ver=1")).href).toBe(
      "https://us.i.posthog.com/e/?ip=0&ver=1",
    );
    expect(postHogUrl(new URL("https://app.relayrunner.dev/ingest/static/array.js")).href).toBe(
      "https://us-assets.i.posthog.com/static/array.js",
    );
    expect(postHogUrl(new URL("https://relayrunner.app/ingest/array/phc_x/config.js")).href).toBe(
      "https://us-assets.i.posthog.com/array/phc_x/config.js",
    );
  });

  test("drops our cookies and passes on the visitor's IP and the body", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fetcher = (async (url: URL, init: RequestInit) => {
      sent = { url: url.href, init };
      return new Response("ok");
    }) as unknown as typeof fetch;
    const request = new Request("https://app.relayrunner.app/ingest/flags/?v=2", {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=secret",
        "cf-connecting-ip": "203.0.113.7",
        "content-type": "application/json",
      },
      body: '{"token":"phc_x"}',
    });
    const response = await proxyPostHog(request, fetcher);
    expect(await response.text()).toBe("ok");
    expect(sent?.url).toBe("https://us.i.posthog.com/flags/?v=2");
    const headers = new Headers(sent?.init.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(headers.get("content-type")).toBe("application/json");
    expect(await new Response(sent?.init.body).text()).toBe('{"token":"phc_x"}');
  });
});
