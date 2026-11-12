import { describe, expect, test } from "vitest";
import {
  anyoneWarning,
  describeMachineWorkspaces,
  machineWorkspaces,
  matchWorkspace,
} from "./machine-workspaces.ts";

const SERVER = "https://app.example.test";
const acme = { id: "w1", name: "Acme", slug: "acme" };
const mine = { id: "w2", name: "atticoos", slug: "atticoos" };
const beta = { id: "w3", name: "Beta Labs", slug: "beta-labs" };
const choice = {
  machine: { id: "m1", name: "M3P0", sharing: "only_me" as const },
  workspaces: [mine],
  others: [acme, beta],
};

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

describe("machineWorkspaces", () => {
  test("gets the machine's workspaces with its token", async () => {
    const { fetcher, requests } = gateway(() => Response.json(choice));
    expect(await machineWorkspaces({ server: SERVER, token: "rrm_secret", fetcher })).toEqual({
      status: "ok",
      choice,
    });
    expect(requests[0]).toMatchObject({
      url: `${SERVER}/api/machines/me/workspaces`,
      method: "GET",
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer rrm_secret");
  });

  test("puts and deletes one workspace", async () => {
    const { fetcher, requests } = gateway(() => Response.json(choice));
    await machineWorkspaces({
      server: SERVER,
      token: "t",
      change: { action: "add", workspaceId: "w1" },
      fetcher,
    });
    await machineWorkspaces({
      server: SERVER,
      token: "t",
      change: { action: "remove", workspaceId: "w2" },
      fetcher,
    });
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["PUT", `${SERVER}/api/machines/me/workspaces/w1`],
      ["DELETE", `${SERVER}/api/machines/me/workspaces/w2`],
    ]);
  });

  test("tells a revoked token, a workspace you left and an older gateway apart", async () => {
    const run = (response: () => Response, change?: boolean) =>
      machineWorkspaces({
        server: SERVER,
        token: "t",
        fetcher: gateway(response).fetcher,
        ...(change && { change: { action: "add" as const, workspaceId: "w9" } }),
      });
    expect(await run(() => new Response(null, { status: 401 }))).toEqual({ status: "revoked" });
    expect(await run(() => Response.json({ error: "not_found" }, { status: 404 }), true)).toEqual({
      status: "not_found",
    });
    expect(await run(() => new Response("404 Not Found", { status: 404 }), true)).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("doesn't support choosing workspaces yet"),
    });
    expect(await run(() => new Response("404 Not Found", { status: 404 }))).toMatchObject({
      status: "failed",
    });
    expect(await run(() => Response.json({ nope: true }))).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("unexpected response"),
    });
  });

  test("says when the gateway can't be reached", async () => {
    const fetcher = (async () => {
      throw new TypeError("fetch failed", { cause: { message: "ECONNREFUSED" } });
    }) as typeof fetch;
    expect(await machineWorkspaces({ server: SERVER, token: "t", fetcher })).toEqual({
      status: "failed",
      reason: `couldn't reach ${SERVER} (ECONNREFUSED)`,
    });
  });
});

describe("matchWorkspace", () => {
  test("matches an id, a name or a slug in any case", () => {
    const all = [acme, mine, beta];
    expect(matchWorkspace(all, "w3")).toEqual({ status: "one", workspace: beta });
    expect(matchWorkspace(all, "ACME")).toEqual({ status: "one", workspace: acme });
    expect(matchWorkspace(all, "beta labs")).toEqual({ status: "one", workspace: beta });
    expect(matchWorkspace(all, "beta-labs")).toEqual({ status: "one", workspace: beta });
    expect(matchWorkspace(all, "gamma")).toEqual({ status: "none" });
  });

  test("reports two workspaces with the same name, and a slug tells them apart", () => {
    const twin = { id: "w4", name: "Acme", slug: "acme-2" };
    expect(matchWorkspace([acme, twin], "Acme")).toEqual({
      status: "several",
      workspaces: [acme, twin],
    });
    expect(matchWorkspace([acme, twin], "acme-2")).toEqual({ status: "one", workspace: twin });
  });
});

describe("describeMachineWorkspaces", () => {
  test("lists the workspaces it's in and the ones it isn't, with its sharing", () => {
    expect(describeMachineWorkspaces(choice)).toBe(
      [
        "M3P0 runs jobs in:",
        "  ✓ atticoos",
        "",
        "Not in:",
        "  · Acme (acme)",
        "  · Beta Labs (beta-labs)",
        "",
        "Sharing: only-me: runs only jobs you started",
        "Add one with `relayrunner workspaces add <name>`.",
      ].join("\n"),
    );
  });

  test("says when it's in none of them", () => {
    const text = describeMachineWorkspaces({ ...choice, workspaces: [], others: [acme] });
    expect(text).toContain("(none: it takes no jobs)");
  });

  test("points an owner with no workspace at installing", () => {
    expect(describeMachineWorkspaces({ ...choice, workspaces: [], others: [] })).toContain(
      "isn't in a workspace yet",
    );
  });

  test("warns that anyone's jobs reach a workspace it joins", () => {
    expect(anyoneWarning("M3P0", "Acme")).toContain(
      "anyone who can push to Acme's private repos can run jobs on it",
    );
  });
});
