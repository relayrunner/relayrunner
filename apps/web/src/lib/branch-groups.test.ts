import { describe, expect, test } from "vitest";
import { groupByBranch } from "./branch-groups.ts";

const job = (
  id: number,
  fields: { branch: string | null; pullRequest?: number; title?: string },
) => ({
  id,
  repositoryId: 1,
  repository: "acme/app",
  branch: fields.branch,
  pullRequest: fields.pullRequest ?? null,
  title: fields.title ?? null,
});

describe("groupByBranch", () => {
  test("groups a branch's jobs, in the order of each group's newest job", () => {
    const groups = groupByBranch([
      job(1, { branch: "fix" }),
      job(2, { branch: "main" }),
      job(3, { branch: "fix", pullRequest: 7, title: "Fix the cache" }),
      job(4, { branch: null }),
      job(5, { branch: "fix" }),
    ]);
    expect(groups.map((group) => group.jobs.map((each) => each.id))).toEqual([[1, 3, 5], [2], [4]]);
    // A push's run on the branch doesn't hide the pull request another run came from.
    expect(groups[0]!.pullRequest).toEqual({ number: 7, title: "Fix the cache" });
    expect(groups[1]!.pullRequest).toBeNull();
    expect(groups[2]!.branch).toBeNull();
  });

  test("keeps the same branch name in two repositories apart", () => {
    const other = { ...job(2, { branch: "main" }), repositoryId: 2, repository: "acme/site" };
    expect(groupByBranch([job(1, { branch: "main" }), other])).toHaveLength(2);
  });
});
