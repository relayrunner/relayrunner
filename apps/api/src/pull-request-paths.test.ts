import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { GitHubAccessError, GitHubRateLimitError, pullRequestFiles } from "./github-app.ts";
import { areaOf, isDocs, summarize, syncPullRequestPaths } from "./pull-request-paths.ts";
import * as testing from "./testing.ts";

vi.mock("./github-app.ts", async (original) => ({
  ...(await original<typeof import("./github-app.ts")>()),
  appInstallationToken: async () => "ghs_test",
  pullRequestFiles: vi.fn(),
}));

const files = vi.mocked(pullRequestFiles);
const listing = (...names: string[]) =>
  names.map((filename) => ({ filename })) as Awaited<ReturnType<typeof pullRequestFiles>>;

let env: Env;
let installations = 0;
let ids = 700_000;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

beforeEach(() => files.mockReset());

async function installation() {
  installations += 1;
  const id = 9500 + installations;
  await createDb(env.DB)
    .insert(schema.githubInstallation)
    .values({ id, accountId: id, accountLogin: `paths-${id}`, accountType: "Organization" });
  return id;
}

// A pull request's run on `headSha`, updated `minutesAgo`.
async function prRun(
  installationId: number,
  pullRequestNumber: number | null,
  headSha: string,
  minutesAgo = 10,
) {
  ids += 1;
  await createDb(env.DB)
    .insert(schema.workflowRun)
    .values({
      id: ids,
      runAttempt: 1,
      installationId,
      repositoryId: installationId * 10,
      repositoryFullName: "acme/app",
      workflowName: "CI",
      event: "pull_request",
      headSha,
      pullRequestNumber,
      status: "completed",
      conclusion: "success",
      githubUpdatedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
}

const stored = (installationId: number) =>
  createDb(env.DB)
    .select()
    .from(schema.pullRequestPaths)
    .where(eq(schema.pullRequestPaths.installationId, installationId));

describe("areaOf", () => {
  test("is the top folder, two levels down in a folder of projects", () => {
    expect(areaOf("README.md")).toBe("/");
    expect(areaOf("docs/setup.md")).toBe("docs");
    expect(areaOf("src/a/b.ts")).toBe("src");
    expect(areaOf("apps/web/src/main.ts")).toBe("apps/web");
    expect(areaOf("packages/ui/index.ts")).toBe("packages/ui");
    // A file right inside a folder of projects is that folder's.
    expect(areaOf("apps/README.md")).toBe("apps");
  });
});

describe("isDocs", () => {
  test("covers prose files, docs folders and licenses", () => {
    for (const file of ["README.md", "docs/a.png", "apps/site/doc/x.ts", "LICENSE", "notes.txt"])
      expect(isDocs(file)).toBe(true);
    for (const file of ["src/index.ts", "package.json", ".github/workflows/ci.yml"])
      expect(isDocs(file)).toBe(false);
  });
});

describe("summarize", () => {
  test("folds names into areas and says whether all of them were docs", () => {
    expect(summarize(["docs/a.md", "README.md"])).toEqual({
      areas: ["/", "docs"],
      docsOnly: true,
    });
    expect(summarize(["apps/web/a.ts", "docs/a.md"]).docsOnly).toBe(false);
    expect(summarize([])).toEqual({ areas: [], docsOnly: false });
    expect(summarize(null)).toEqual({ areas: [], docsOnly: false });
  });
});

describe("syncPullRequestPaths", () => {
  test("reads each pull request once per head commit", async () => {
    const id = await installation();
    await prRun(id, 1, "a");
    await prRun(id, 2, "b");
    // A push with no pull request has nothing to read.
    await prRun(id, null, "c");
    files.mockResolvedValue(listing("docs/a.md"));
    const db = createDb(env.DB);

    expect(await syncPullRequestPaths(env, db, id)).toBe(2);
    expect(await stored(id)).toHaveLength(2);
    expect(await syncPullRequestPaths(env, db, id)).toBe(0);

    // A new commit on #1 reads it again.
    await prRun(id, 1, "a2", 1);
    files.mockResolvedValue(listing("apps/web/a.ts"));
    expect(await syncPullRequestPaths(env, db, id)).toBe(1);
    const one = (await stored(id)).find((row) => row.pullRequestNumber === 1);
    expect(one).toMatchObject({ headSha: "a2", areas: ["apps/web"], docsOnly: false });
  });

  test("stores missing pull requests without areas and stops at a refusal or rate limit", async () => {
    const id = await installation();
    await prRun(id, 1, "a", 3);
    await prRun(id, 2, "b", 2);
    await prRun(id, 3, "c", 1);
    files.mockImplementation(async (_token, _repo, number) => {
      if (number === 3) throw new GitHubAccessError("gone", 404);
      if (number === 2) throw new GitHubRateLimitError("slow down");
      return listing("src/a.ts");
    });
    // One at a time would stop before #1; in parallel it may not, so only check what's stored.
    await syncPullRequestPaths(env, createDb(env.DB), id);
    const rows = await stored(id);
    expect(rows.map((row) => row.pullRequestNumber)).not.toContain(2);
    expect(rows.find((row) => row.pullRequestNumber === 3)).toMatchObject({ areas: [] });
  });

  test("stores a pull request with too many files to list without areas", async () => {
    const id = await installation();
    await prRun(id, 1, "a");
    files.mockResolvedValue(null);
    await syncPullRequestPaths(env, createDb(env.DB), id);
    expect(await stored(id)).toMatchObject([{ areas: [], docsOnly: false }]);
  });
});
