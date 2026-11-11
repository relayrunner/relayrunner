import { describe, expect, test } from "vitest";
import { CLIENT_ID, login, type DeviceCode } from "./login.ts";

const SERVER = "https://app.example.test";

type Reply = { status: number; body: unknown };

// A fake gateway: answers each path from a queue of replies and records the requests.
function fakeGateway(replies: Record<string, Reply[]>) {
  const requests: { path: string; headers: Headers; body: unknown }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const queue = replies[url.pathname];
    const reply = queue?.length === 1 ? queue[0] : queue?.shift();
    if (!reply) throw new Error(`unexpected ${url.pathname}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { fetcher, requests };
}

const code = {
  status: 200,
  body: {
    device_code: "dev-123",
    user_code: "ABCD1234",
    verification_uri: `${SERVER}/device`,
    verification_uri_complete: `${SERVER}/device?user_code=ABCD1234`,
    expires_in: 600,
    interval: 5,
  },
};
const pending = { status: 400, body: { error: "authorization_pending" } };
const claimed = {
  status: 200,
  body: {
    machine: { id: "m1", name: "laptop", os: "macos", arch: "arm64" },
    workspace: { id: "w1", name: "Acme", slug: "acme" },
    token: "rrm_secret",
  },
};

function run(replies: Record<string, Reply[]>) {
  const gateway = fakeGateway(replies);
  const sleeps: number[] = [];
  let shown: DeviceCode | undefined;
  let clock = 0;
  const result = login({
    server: SERVER,
    name: "laptop.local",
    platform: { os: "macos", arch: "arm64" },
    onCode: (c) => {
      shown = c;
    },
    fetcher: gateway.fetcher,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { result, gateway, sleeps, shown: () => shown };
}

describe("login", () => {
  test("shows the code, polls until approved, and claims the machine", async () => {
    const { result, gateway, sleeps, shown } = run({
      "/api/auth/device/code": [code],
      "/api/auth/device/token": [
        pending,
        { status: 400, body: { error: "slow_down" } },
        { status: 200, body: { access_token: "session-tok", token_type: "Bearer" } },
      ],
      "/api/machines/claim": [claimed],
    });

    expect(await result).toEqual({
      credentials: {
        server: SERVER,
        machine: { id: "m1", name: "laptop" },
        token: "rrm_secret",
      },
      workspaces: [{ id: "w1", name: "Acme", slug: "acme" }],
    });
    expect(shown()).toEqual({
      userCode: "ABCD1234",
      url: `${SERVER}/device?user_code=ABCD1234&name=laptop.local`,
      expiresAt: 600_000,
    });
    // slow_down adds five seconds to the interval.
    expect(sleeps).toEqual([5000, 5000, 10000]);

    expect(gateway.requests.map((r) => r.path)).toEqual([
      "/api/auth/device/code",
      "/api/auth/device/token",
      "/api/auth/device/token",
      "/api/auth/device/token",
      "/api/machines/claim",
    ]);
    expect(gateway.requests[0].body).toEqual({ client_id: CLIENT_ID });
    expect(gateway.requests[1].body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dev-123",
      client_id: CLIENT_ID,
    });
    const claim = gateway.requests[4];
    expect(claim.headers.get("authorization")).toBe("Bearer session-tok");
    expect(claim.body).toEqual({ deviceCode: "dev-123", os: "macos", arch: "arm64" });
  });

  test("passes on every workspace the machine is in, without saving them", async () => {
    const acme = { id: "w1", name: "Acme", slug: "acme", memberCount: 3 };
    const mine = { id: "w2", name: "atticoos", slug: "atticoos", memberCount: 1 };
    const { result } = run({
      "/api/auth/device/code": [code],
      "/api/auth/device/token": [{ status: 200, body: { access_token: "session-tok" } }],
      "/api/machines/claim": [
        { status: 200, body: { ...claimed.body, workspace: acme, workspaces: [acme, mine] } },
      ],
    });
    const { credentials, workspaces } = await result;
    expect(workspaces).toEqual([acme, mine]);
    expect(credentials).not.toHaveProperty("workspace");
  });

  test("a machine whose owner has no workspace yet still signs in", async () => {
    const { result } = run({
      "/api/auth/device/code": [code],
      "/api/auth/device/token": [{ status: 200, body: { access_token: "session-tok" } }],
      "/api/machines/claim": [
        { status: 200, body: { ...claimed.body, workspace: null, workspaces: [] } },
      ],
    });
    const { credentials, workspaces } = await result;
    expect(workspaces).toEqual([]);
    expect(credentials.token).toBe("rrm_secret");
  });

  test("a denied code fails", async () => {
    const { result } = run({
      "/api/auth/device/code": [code],
      "/api/auth/device/token": [{ status: 400, body: { error: "access_denied" } }],
    });
    await expect(result).rejects.toMatchObject({ code: "DENIED" });
  });

  test("gives up when the code expires", async () => {
    const { result, gateway } = run({
      "/api/auth/device/code": [code],
      "/api/auth/device/token": [pending],
    });
    await expect(result).rejects.toMatchObject({ code: "EXPIRED" });
    // 600 s at a 5 s interval.
    expect(gateway.requests.filter((r) => r.path === "/api/auth/device/token")).toHaveLength(120);
  });

  test("a claim the gateway refuses fails", async () => {
    const { result } = run({
      "/api/auth/device/code": [code],
      "/api/auth/device/token": [{ status: 200, body: { access_token: "session-tok" } }],
      "/api/machines/claim": [{ status: 404, body: { error: "not_found" } }],
    });
    await expect(result).rejects.toMatchObject({ code: "CLAIM_FAILED" });
  });
});
