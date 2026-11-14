import { describe, expect, test } from "vitest";
import { setPaused } from "./pause.ts";

const SERVER = "https://app.example.test";

function gateway(reply: () => Response | Promise<Response>) {
  const requests: { url: string; method?: string; headers: Headers }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
    });
    return reply();
  }) as typeof fetch;
  return { fetcher, requests };
}

const machine = (paused: boolean, state: string | null = "idle") => ({
  machine: {
    name: "laptop",
    paused: paused ? { at: "2026-11-05T19:00:00.000Z", by: null } : null,
    status: { online: true, state, connectedAt: 1 },
  },
});

describe("setPaused", () => {
  test("posts to /me/pause or /me/resume with the machine token", async () => {
    const { fetcher, requests } = gateway(() => Response.json(machine(true)));
    expect(await setPaused({ server: SERVER, token: "rrm_secret", paused: true, fetcher })).toEqual(
      { status: "ok", paused: true, busy: false },
    );
    expect(requests[0]).toMatchObject({ url: `${SERVER}/api/machines/me/pause`, method: "POST" });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer rrm_secret");

    const resume = gateway(() => Response.json(machine(false)));
    expect(
      await setPaused({
        server: SERVER,
        token: "rrm_secret",
        paused: false,
        fetcher: resume.fetcher,
      }),
    ).toEqual({ status: "ok", paused: false, busy: false });
    expect(resume.requests[0]?.url).toBe(`${SERVER}/api/machines/me/resume`);
  });

  test("says when the machine is finishing a job", async () => {
    const { fetcher } = gateway(() => Response.json(machine(true, "busy")));
    expect(await setPaused({ server: SERVER, token: "t", paused: true, fetcher })).toMatchObject({
      busy: true,
    });
  });

  test("a 401 means the token was revoked; anything else fails with why", async () => {
    const revoked = gateway(() => new Response(null, { status: 401 }));
    expect(
      await setPaused({ server: SERVER, token: "t", paused: true, fetcher: revoked.fetcher }),
    ).toEqual({ status: "revoked" });

    const broken = gateway(() => new Response("nope", { status: 500 }));
    expect(
      await setPaused({ server: SERVER, token: "t", paused: true, fetcher: broken.fetcher }),
    ).toEqual({ status: "failed", reason: `${SERVER} answered HTTP 500` });

    const owned = gateway(() =>
      Response.json(
        {
          error: {
            code: "MACHINE_NOT_OWNED",
            message: "Only a machine with an owner can do this.",
          },
        },
        { status: 403 },
      ),
    );
    expect(
      await setPaused({ server: SERVER, token: "t", paused: true, fetcher: owned.fetcher }),
    ).toEqual({
      status: "failed",
      reason: "Only a machine with an owner can do this (MACHINE_NOT_OWNED)",
    });

    const offline = (async () => {
      throw new TypeError("fetch failed", { cause: { message: "ENOTFOUND" } });
    }) as typeof fetch;
    expect(await setPaused({ server: SERVER, token: "t", paused: true, fetcher: offline })).toEqual(
      { status: "failed", reason: `couldn't reach ${SERVER} (ENOTFOUND)` },
    );
  });
});
