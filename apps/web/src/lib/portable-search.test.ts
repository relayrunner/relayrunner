import { describe, expect, it } from "vitest";
import { portableSearch } from "./portable-search.ts";

describe("portableSearch", () => {
  it("keeps ranges and fixed choices, and drops what names a workspace's own things", () => {
    expect(
      portableSearch("/history", {
        view: "runs",
        range: "7d",
        result: "failure",
        repo: "web",
        chart: "CI",
        run: "1-2",
        q: "deploy",
        runner: "m-1",
      }),
    ).toEqual({ view: "runs", range: "7d", result: "failure" });
  });

  it("keeps a provider's chart, which is a metric", () => {
    expect(portableSearch("/providers/github", { chart: "minutes", range: "30d" })).toEqual({
      chart: "minutes",
      range: "30d",
    });
  });

  it("drops runner owners and signal filters", () => {
    expect(portableSearch("/runners", { status: "online", owner: "sam" })).toEqual({
      status: "online",
    });
    expect(portableSearch("/signals", { by: "repo", person: "sam", signal: "slow" })).toEqual({
      by: "repo",
    });
  });
});
