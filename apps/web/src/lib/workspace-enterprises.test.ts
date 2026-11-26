import { describe, expect, test } from "vitest";
import { groupByEnterprise } from "./workspace-enterprises";

describe("groupByEnterprise", () => {
  test("puts workspaces in no enterprise first, then each enterprise's in list order", () => {
    const workspaces = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    const beta = { slug: "beta", avatar: "beta.png" };
    const alpha = { slug: "alpha", avatar: "alpha.png" };
    expect(
      groupByEnterprise(workspaces, [
        { id: "a", enterprise: beta },
        { id: "b", enterprise: null },
        { id: "c", enterprise: alpha },
        { id: "d", enterprise: beta },
      ]),
    ).toEqual({
      alone: [{ id: "b" }, { id: "e" }],
      enterprises: [
        { enterprise: beta, workspaces: [{ id: "a" }, { id: "d" }] },
        { enterprise: alpha, workspaces: [{ id: "c" }] },
      ],
    });
  });
});
