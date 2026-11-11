import { describe, expect, test } from "vitest";
import { whoami } from "./whoami.ts";

const SERVER = "https://app.example.test";

const identity = {
  machine: {
    id: "m1",
    name: "laptop",
    os: "macos",
    arch: "arm64",
    lastSeenAt: null,
    revokedAt: null,
    createdAt: "2026-11-04T12:00:00.000Z",
    status: { online: true, state: "idle", connectedAt: 1 },
  },
  workspace: { id: "w1", name: "Acme", slug: "acme" },
  enrolledBy: { id: "u1", name: "Atticus", email: "a@example.test" },
};

function gateway(reply: () => Response | Promise<Response>) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return reply();
  }) as typeof fetch;
  return { fetcher, requests };
}

describe("whoami", () => {
  test("asks /api/machines/me with the machine token", async () => {
    const { fetcher, requests } = gateway(() => Response.json(identity));
    const result = await whoami({ server: SERVER, token: "rrm_secret", fetcher });
    expect(requests[0]?.url).toBe(`${SERVER}/api/machines/me`);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer rrm_secret");
    expect(result).toMatchObject({
      status: "ok",
      identity: {
        machine: { name: "laptop", status: { online: true } },
        workspace: { name: "Acme" },
        enrolledBy: { email: "a@example.test" },
      },
    });
  });

  test("reads every workspace the machine is in, or none yet", async () => {
    const workspaces = [
      { id: "w1", name: "Acme", slug: "acme", memberCount: 3 },
      { id: "w2", name: "atticoos", slug: "atticoos", memberCount: 1 },
    ];
    const listed = gateway(() => Response.json({ ...identity, workspaces }));
    expect(
      await whoami({ server: SERVER, token: "rrm_secret", fetcher: listed.fetcher }),
    ).toMatchObject({ status: "ok", identity: { workspaces } });

    const none = gateway(() => Response.json({ ...identity, workspace: null, workspaces: [] }));
    expect(
      await whoami({ server: SERVER, token: "rrm_secret", fetcher: none.fetcher }),
    ).toMatchObject({ status: "ok", identity: { workspace: null, workspaces: [] } });
  });

  test("a 401 means the machine was revoked", async () => {
    const { fetcher } = gateway(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    expect(await whoami({ server: SERVER, token: "rrm_old", fetcher })).toEqual({
      status: "revoked",
    });
  });

  test("an unreachable gateway leaves the identity unverified", async () => {
    const { fetcher } = gateway(() => {
      throw new TypeError("fetch failed", { cause: { message: "ENOTFOUND" } });
    });
    expect(await whoami({ server: SERVER, token: "rrm_secret", fetcher })).toEqual({
      status: "unverified",
      reason: `Couldn't reach ${SERVER} (ENOTFOUND)`,
    });
  });

  test("an error or unexpected body leaves it unverified", async () => {
    const failing = gateway(() => new Response("nope", { status: 502 }));
    expect(await whoami({ server: SERVER, token: "rrm_secret", fetcher: failing.fetcher })).toEqual(
      { status: "unverified", reason: `${SERVER} answered HTTP 502` },
    );
    const odd = gateway(() => Response.json({ hello: "world" }));
    expect(await whoami({ server: SERVER, token: "rrm_secret", fetcher: odd.fetcher })).toEqual({
      status: "unverified",
      reason: `${SERVER} sent an unexpected response`,
    });
  });
});
