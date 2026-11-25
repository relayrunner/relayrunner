import { afterEach, describe, expect, test, vi } from "vitest";
import { hasRelay, relayOnDefaultBranch } from "./relay-on-default.ts";

describe("hasRelay", () => {
  test("finds the relay workflow or the relayrunner label", () => {
    expect(hasRelay("    uses: relayrunner/actions/.github/workflows/relay.yml@v1")).toBe(true);
    expect(hasRelay("    runs-on: relayrunner")).toBe(true);
    expect(hasRelay('    runs-on: ["RelayRunner"]')).toBe(true);
  });

  test("ignores other labels and a missing file", () => {
    expect(hasRelay("    runs-on: ubuntu-latest")).toBe(false);
    expect(hasRelay("    runs-on: relayrunner-container")).toBe(false);
    expect(hasRelay("    runs-on: ${{ needs.relay.outputs.runner }}")).toBe(false);
    expect(hasRelay(null)).toBe(false);
  });
});

describe("relayOnDefaultBranch", () => {
  const RELAYED = "jobs:\n  relay:\n    uses: relayrunner/actions/.github/workflows/relay.yml@v1\n";
  const PLAIN = "jobs:\n  test:\n    runs-on: ubuntu-latest\n";

  afterEach(() => vi.unstubAllGlobals());

  /** GitHub with the file's text now, and its last commit (and text) as of the last relay. */
  function github(now: string | null, then: { sha: string; text: string | null } | null) {
    const fetcher = vi.fn(async (url: string) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname.endsWith("/commits")) return Response.json(then ? [{ sha: then.sha }] : []);
      const text = searchParams.get("ref") ? (then?.text ?? null) : now;
      return text === null ? new Response("", { status: 404 }) : new Response(text);
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  const check = () =>
    relayOnDefaultBranch("t", "acme/app", ".github/workflows/ci.yml", new Date("2026-11-25"));

  test("present while the default branch still has it", async () => {
    const fetcher = github(RELAYED, null);
    expect(await check()).toBe("present");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("removed when the default branch had it at the last relay", async () => {
    github(PLAIN, { sha: "abc", text: RELAYED });
    expect(await check()).toBe("removed");
  });

  test("removed when the file is gone", async () => {
    github(null, { sha: "abc", text: RELAYED });
    expect(await check()).toBe("removed");
  });

  test("never merged when the default branch never had it", async () => {
    github(PLAIN, { sha: "abc", text: PLAIN });
    expect(await check()).toBe("never_merged");
    github(null, null);
    expect(await check()).toBe("never_merged");
  });
});
