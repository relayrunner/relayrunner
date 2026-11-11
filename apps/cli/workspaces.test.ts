import { describe, expect, test } from "vitest";
import {
  hasTeammates,
  noWorkspaceYet,
  readWorkspaces,
  sharingScope,
  workspaceNames,
} from "./workspaces.ts";

const acme = { id: "w1", name: "Acme", memberCount: 3 };
const mine = { id: "w2", name: "atticoos", memberCount: 1 };

describe("readWorkspaces", () => {
  test("takes the list when the gateway sends one", () => {
    expect(readWorkspaces({ workspace: acme, workspaces: [acme, mine] })).toEqual([acme, mine]);
  });

  test("falls back to the single workspace from an older gateway", () => {
    expect(readWorkspaces({ workspace: acme })).toEqual([acme]);
  });

  test("is empty when the owner has no workspace yet", () => {
    expect(readWorkspaces({ workspace: null, workspaces: [] })).toEqual([]);
    expect(readWorkspaces({ workspace: null })).toEqual([]);
    expect(readWorkspaces({})).toEqual([]);
  });
});

describe("hasTeammates", () => {
  test("is true when any workspace has someone else in it", () => {
    expect(hasTeammates([mine, acme])).toBe(true);
    expect(hasTeammates([mine])).toBe(false);
    expect(hasTeammates([{ id: "w3", name: "Old" }])).toBe(false);
    expect(hasTeammates([])).toBe(false);
  });
});

describe("workspace names", () => {
  test("joins names with commas and 'and'", () => {
    expect(workspaceNames([acme])).toBe("Acme");
    expect(workspaceNames([acme, mine])).toBe("Acme and atticoos");
    expect(workspaceNames([acme, { name: "Beta" }, mine])).toBe("Acme, Beta and atticoos");
  });

  test("names the one workspace sharing reaches, or all of yours", () => {
    expect(sharingScope([acme])).toBe("Acme");
    expect(sharingScope([acme, mine])).toBe("your workspaces");
    expect(sharingScope([])).toBe("your workspaces");
  });

  test("points a machine with no workspace at the install page", () => {
    expect(noWorkspaceYet("M3P0", "https://app.relayrunner.app")).toContain(
      "Install: https://app.relayrunner.app/api/github/install",
    );
  });
});
