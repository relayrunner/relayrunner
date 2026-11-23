import { expect, test, vi } from "vitest";
import { createDb, schema } from "../db/index.ts";
import { runnerUpdate, syncRunnerReleases } from "./runner-releases.ts";
import { createTestEnv } from "../testing.ts";

const release = (version: string, day: string) => ({
  version,
  publishedAt: new Date(`${day}T00:00:00Z`),
});

test("a runner behind has the newest release and 30 days from the first one past it", () => {
  const releases = [
    release("2.329.0", "2026-09-01"),
    release("2.330.0", "2026-10-01"),
    release("2.331.0", "2026-11-01"),
  ];
  expect(runnerUpdate("2.329.0", releases)).toEqual({
    update: "2.331.0",
    updateBy: new Date("2026-10-31T00:00:00Z"),
  });
  expect(runnerUpdate("2.330.0", releases)).toEqual({
    update: "2.331.0",
    updateBy: new Date("2026-12-01T00:00:00Z"),
  });
  expect(runnerUpdate("2.331.0", releases)).toEqual({ update: null, updateBy: null });
  // Before any release is saved, nothing reads as behind.
  expect(runnerUpdate("2.300.0", [])).toEqual({ update: null, updateBy: null });
});

test("saves published releases from GitHub, skipping drafts and prereleases", async () => {
  const env = await createTestEnv();
  const db = createDb(env.DB);
  const fetcher: typeof fetch = vi.fn(async () =>
    Response.json([
      { tag_name: "v2.332.0", draft: true, prerelease: false, published_at: null },
      {
        tag_name: "v2.331.1",
        draft: false,
        prerelease: true,
        published_at: "2026-11-10T00:00:00Z",
      },
      {
        tag_name: "v2.331.0",
        draft: false,
        prerelease: false,
        published_at: "2026-11-01T00:00:00Z",
      },
      {
        tag_name: "v2.330.0",
        draft: false,
        prerelease: false,
        published_at: "2026-10-01T00:00:00Z",
      },
    ]),
  );
  expect(await syncRunnerReleases(db, undefined, fetcher)).toBe(2);
  // Running again keeps the rows as they are.
  await syncRunnerReleases(db, undefined, fetcher);
  const rows = await db.select().from(schema.runnerRelease);
  expect(rows.map((row) => row.version).sort()).toEqual(["2.330.0", "2.331.0"]);
});

test("fails when GitHub doesn't answer", async () => {
  const env = await createTestEnv();
  const fetcher: typeof fetch = async () => new Response("rate limited", { status: 403 });
  await expect(syncRunnerReleases(createDb(env.DB), undefined, fetcher)).rejects.toThrow(
    "Status 403",
  );
});

test("sends the installation token when there is one", async () => {
  const env = await createTestEnv();
  let authorization: string | null = null;
  const fetcher: typeof fetch = async (_url, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return Response.json([]);
  };
  await syncRunnerReleases(createDb(env.DB), "ghs_test", fetcher);
  expect(authorization).toBe("Bearer ghs_test");
});
