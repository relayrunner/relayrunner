import { describe, expect, it } from "vitest";
import { checkJitConfig } from "./jit-config.ts";
import { fakeJitConfig } from "./jit-config.fixture.ts";

describe("checkJitConfig", () => {
  it("accepts GitHub's config for this route and says which repo it's for", () => {
    expect(checkJitConfig(fakeJitConfig("a1b2"), "a1b2")).toEqual({ ok: true, target: "acme/app" });
  });

  it("names the org for an org runner", () => {
    const config = fakeJitConfig("a1b2", { runner: { GitHubUrl: "https://github.com/acme" } });
    expect(checkJitConfig(config, "a1b2")).toEqual({ ok: true, target: "acme" });
  });

  it("refuses a config that points the runner at another server", () => {
    const config = fakeJitConfig("a1b2", { runner: { ServerUrlV2: "https://evil.example/" } });
    expect(checkJitConfig(config, "a1b2")).toEqual({
      ok: false,
      reason: "it points the runner at https://evil.example, not GitHub",
    });
  });

  it("checks URLs in .credentials too, and look-alike hosts", () => {
    const config = fakeJitConfig("a1b2", {
      credentials: { AuthorizationUrl: "https://github.com.evil.example/token" },
    });
    expect(checkJitConfig(config, "a1b2")).toMatchObject({ ok: false, reason: /not GitHub/ });
  });

  it("refuses plain http, even to GitHub", () => {
    const config = fakeJitConfig("a1b2", { runner: { ServerUrl: "http://github.com/x" } });
    expect(checkJitConfig(config, "a1b2")).toMatchObject({ ok: false, reason: /not GitHub/ });
  });

  it("refuses a runner minted for another job", () => {
    expect(checkJitConfig(fakeJitConfig("a1b2"), "c3d4")).toEqual({
      ok: false,
      reason: "its runner zach-mbp-a1b2 isn't for job c3d4",
    });
  });

  it("refuses a config with no server", () => {
    const config = fakeJitConfig("a1b2", { runner: { ServerUrl: null, ServerUrlV2: null } });
    expect(checkJitConfig(config, "a1b2")).toMatchObject({ ok: false, reason: /which GitHub/ });
  });

  it("refuses something that isn't a config at all", () => {
    expect(checkJitConfig("abc", "a1b2")).toEqual({
      ok: false,
      reason: "it isn't a runner config",
    });
  });
});
