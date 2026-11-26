import { describe, expect, test } from "vitest";
import { GitHubAccessError, GitHubError } from "./github/github-api.ts";
import { isTransient } from "./transient.ts";

describe("isTransient", () => {
  test("GitHub 5xx, D1 overloaded, timeouts and dropped connections", () => {
    expect(
      isTransient(new GitHubError(503, "POST /app/installations/:id/access_tokens failed")),
    ).toBe(true);
    expect(isTransient(new GitHubError(520, "Could not find the latest runner version"))).toBe(
      true,
    );
    const overloaded = new Error("Failed query: select 1", {
      cause: new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."),
    });
    expect(isTransient(overloaded)).toBe(true);
    expect(isTransient(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe(true);
    expect(isTransient(new Error("Network connection lost."))).toBe(true);
    expect(isTransient(new Error("wrapped", { cause: new GitHubError(502, "bad gateway") }))).toBe(
      true,
    );
  });

  test("not GitHub refusing the call, a bad token, or a bug", () => {
    expect(isTransient(new GitHubAccessError("GET /orgs/:org failed with 403", 403))).toBe(false);
    expect(isTransient(new GitHubError(401, "Bad credentials"))).toBe(false);
    expect(isTransient(new GitHubError(422, "Runner is running a job"))).toBe(false);
    expect(isTransient(new SyntaxError("Unexpected end of JSON input"))).toBe(false);
    expect(isTransient("boom")).toBe(false);
  });
});
