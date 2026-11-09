import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { unifiedDiff } from "./diff.ts";
import { changesFor, InitError, planInit, selectJobs, writeChanges } from "./init.ts";
import { parseGitHubRemote, repoVisibility } from "./repo.ts";

function checkout(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "rr-init-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const [name, source] of Object.entries(files))
    writeFileSync(join(root, ".github/workflows", name), source);
  return root;
}

const ci =
  "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n  lint:\n    runs-on: ubuntu-latest\n";
const deploy = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    environment: prod\n";

describe("planInit", () => {
  test("outside a checkout", async () => {
    await expect(planInit(tmpdir())).rejects.toBeInstanceOf(InitError);
  });

  test("reads the workflows from a subdirectory of the checkout", async () => {
    const root = checkout({ "ci.yml": ci });
    mkdirSync(join(root, "src"));
    const plan = await planInit(join(root, "src"), { hostOs: "linux" });
    expect(plan.root).toBe(root);
    expect(plan.repo).toBeNull();
    expect(plan.jobs.map((job) => `${job.job}:${job.verdict}`)).toEqual([
      "test:ready",
      "lint:ready",
    ]);
  });
});

describe("selectJobs", () => {
  test("by id, by file:id, and all", async () => {
    const plan = await planInit(checkout({ "ci.yml": ci, "deploy.yml": deploy }), {
      hostOs: "linux",
    });
    expect(selectJobs(plan.jobs, ["lint"]).map((job) => job.job)).toEqual(["lint"]);
    expect(selectJobs(plan.jobs, ["ci.yml:test"]).map((job) => job.file)).toEqual([
      ".github/workflows/ci.yml",
    ]);
    expect(selectJobs(plan.jobs, ["all"])).toHaveLength(2);
    expect(() => selectJobs(plan.jobs, ["test"])).toThrow("more than one workflow");
    expect(() => selectJobs(plan.jobs, ["deploy.yml:test"])).toThrow("deploy job");
    expect(() => selectJobs(plan.jobs, ["nope"])).toThrow("No job named nope");
  });

  test("writes the chosen jobs and nothing else", async () => {
    const root = checkout({ "ci.yml": ci });
    const plan = await planInit(root, { hostOs: "linux" });
    writeChanges(root, changesFor(plan, selectJobs(plan.jobs, ["lint"])));
    const written = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(written).toContain("relay-lint:");
    expect(written).not.toContain("relay-test:");
    const again = await planInit(root, { hostOs: "linux" });
    expect(again.jobs.map((job) => `${job.job}:${job.verdict}`)).toEqual([
      "test:ready",
      "lint:routed",
    ]);
  });
});

describe("repo", () => {
  test.each([
    ["https://github.com/acme/web.git", "acme/web"],
    ["https://github.com/acme/web", "acme/web"],
    ["https://token@github.com/acme/web.git", "acme/web"],
    ["git@github.com:acme/my.repo.git", "acme/my.repo"],
    ["ssh://git@github.com/acme/web.git", "acme/web"],
    ["https://gitlab.com/acme/web.git", null],
  ])("parses %s", (url, repo) => {
    expect(parseGitHubRemote(url)).toBe(repo);
  });

  test("visibility without signing in", async () => {
    const reply = (status: number, body?: unknown) =>
      (async () => new Response(body ? JSON.stringify(body) : null, { status })) as typeof fetch;
    expect(await repoVisibility("a/b", reply(200, { private: false }))).toBe("public");
    expect(await repoVisibility("a/b", reply(404))).toBe("private");
    expect(await repoVisibility("a/b", reply(403))).toBe("unknown");
    const offline = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await repoVisibility("a/b", offline)).toBe("unknown");
  });
});

describe("unifiedDiff", () => {
  test("shows removed lines before added ones, with context", () => {
    expect(unifiedDiff("a\nb\nc\nd\n", "a\nb\nC\nd\n", "f.yml")).toBe(
      ["--- a/f.yml", "+++ b/f.yml", "@@ -1,5 +1,5 @@", " a", " b", "-c", "+C", " d", " "].join(
        "\n",
      ),
    );
    expect(unifiedDiff("same\n", "same\n", "f.yml")).toBe("");
  });
});
