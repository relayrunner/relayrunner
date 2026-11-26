import { afterEach, describe, expect, test, vi } from "vitest";
import { getJson, getJsonOrNull, GitHubError, pathPattern } from "./github-api.ts";

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

describe("pathPattern", () => {
  test("swaps owners, repos, accounts and ids for placeholders", () => {
    expect(pathPattern("/repos/acme/app/actions/runners/generate-jitconfig")).toBe(
      "/repos/:owner/:repo/actions/runners/generate-jitconfig",
    );
    expect(pathPattern("/repos/acme/app/actions/runners/570")).toBe(
      "/repos/:owner/:repo/actions/runners/:id",
    );
    expect(pathPattern("/app/installations/182005137/access_tokens")).toBe(
      "/app/installations/:id/access_tokens",
    );
    expect(pathPattern("/users/luca/settings/billing/usage?year=2026&month=11")).toBe(
      "/users/:user/settings/billing/usage",
    );
    expect(pathPattern("/orgs/acme/installations")).toBe("/orgs/:org/installations");
    expect(pathPattern("/enterprises/big/settings/billing/usage")).toBe(
      "/enterprises/:enterprise/settings/billing/usage",
    );
  });

  test("leaves the repo out of a failed call's message", async () => {
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    const failure = getJson("t", "/repos/acme/app/actions/jobs/1");
    await expect(failure).rejects.toThrow(
      "GET /repos/:owner/:repo/actions/jobs/:id failed with 500",
    );
    vi.unstubAllGlobals();
  });
});
