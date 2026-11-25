import { afterEach, describe, expect, test, vi } from "vitest";
import { getJson, getJsonOrNull, GitHubError } from "./github-api.ts";

describe("getJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("an empty 200 is GitHub's failure, not a SyntaxError", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
    const failure = getJsonOrNull("t", "/repos/acme/app/actions/jobs/1");
    await expect(failure).rejects.toBeInstanceOf(GitHubError);
    await expect(failure).rejects.toMatchObject({ status: 502 });
  });

  test("reads a body, and a 404 as null", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ id: 1 }));
    expect(await getJson("t", "/app")).toEqual({ id: 1 });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    expect(await getJsonOrNull("t", "/app")).toBeNull();
  });
});
