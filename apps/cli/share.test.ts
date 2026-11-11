import { describe, expect, test } from "vitest";
import { describeSharing, parseShareChoice, setSharing, toChoice, toSharing } from "./share.ts";

const SERVER = "https://app.example.test";

function gateway(reply: () => Response | Promise<Response>) {
  const requests: { url: string; method?: string; headers: Headers; body: unknown }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return reply();
  }) as typeof fetch;
  return { fetcher, requests };
}

describe("share choices", () => {
  test("the CLI's words map to the gateway's and back", () => {
    expect(parseShareChoice("only-me")).toBe("only-me");
    expect(parseShareChoice("anyone")).toBe("anyone");
    expect(parseShareChoice("team")).toBeNull();
    expect(parseShareChoice("only_me")).toBeNull();
    expect(toSharing("only-me")).toBe("only_me");
    expect(toChoice("only_me")).toBe("only-me");
    expect(toChoice(toSharing("anyone"))).toBe("anyone");
  });

  test("describes each setting with the same words", () => {
    expect(describeSharing("only_me")).toBe("only-me: runs only jobs you started");
    expect(describeSharing("anyone", "Acme")).toBe(
      "anyone: runs any job in Acme, including teammates' and bots'",
    );
  });
});

describe("setSharing", () => {
  test("puts the setting to /me/sharing with the machine token", async () => {
    const { fetcher, requests } = gateway(() => Response.json({ machine: { sharing: "anyone" } }));
    expect(
      await setSharing({ server: SERVER, token: "rrm_secret", sharing: "anyone", fetcher }),
    ).toEqual({ status: "ok", sharing: "anyone" });
    expect(requests[0]).toMatchObject({
      url: `${SERVER}/api/machines/me/sharing`,
      method: "PUT",
      body: { sharing: "anyone" },
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer rrm_secret");
  });

  test("a 401 means the machine was removed", async () => {
    const { fetcher } = gateway(() => new Response("", { status: 401 }));
    expect(await setSharing({ server: SERVER, token: "t", sharing: "only_me", fetcher })).toEqual({
      status: "revoked",
    });
  });

  test("an older gateway, an error or an unreachable one fails with a reason", async () => {
    const old = gateway(() => new Response("", { status: 404 }));
    expect(
      await setSharing({ server: SERVER, token: "t", sharing: "anyone", fetcher: old.fetcher }),
    ).toEqual({ status: "failed", reason: `${SERVER} doesn't support sharing yet` });

    const broken = gateway(() => new Response("", { status: 500 }));
    expect(
      await setSharing({ server: SERVER, token: "t", sharing: "anyone", fetcher: broken.fetcher }),
    ).toEqual({ status: "failed", reason: `${SERVER} answered HTTP 500` });

    const down = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { message: "ECONNREFUSED" } });
    }) as typeof fetch;
    expect(
      await setSharing({ server: SERVER, token: "t", sharing: "anyone", fetcher: down }),
    ).toEqual({ status: "failed", reason: `couldn't reach ${SERVER} (ECONNREFUSED)` });
  });
});
