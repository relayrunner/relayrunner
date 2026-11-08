import { describe, expect, test, vi } from "vitest";
import {
  checkConventionalTitle,
  jobCommit,
  nativeJob,
  nativeVerdict,
  pullRequestTitle,
  runChecks,
  type CheckStep,
} from "./native-checks.ts";

// A step as the job message carries it: the runner's ActionStep JSON.
const checkStep = (path: string, inputs?: unknown) => ({
  type: "action",
  reference: {
    type: "repository",
    name: "relayrunner/actions",
    ref: "v1",
    repositoryType: "GitHub",
    path,
  },
  ...(inputs === undefined ? {} : { inputs }),
});
const runStep = {
  type: "action",
  reference: { type: "script" },
  displayName: "Run pnpm lint",
  inputs: { type: 2, map: [{ Key: "script", Value: "pnpm lint" }] },
};

// PipelineContextData: a dictionary is {t: 2, d: [{k, v}]}.
const dict = (entries: Record<string, unknown>) => ({
  t: 2,
  d: Object.entries(entries).map(([k, v]) => ({ k, v })),
});
// A fake container: lint passes unless a test says otherwise.
const fakeDeps = () => ({ lint: vi.fn(async () => ({ ok: true }) as const) });
const deps = fakeDeps();

const prContext = (title: string) => ({
  github: dict({
    repository: "relayrunner/relayrunner",
    event_name: "pull_request",
    event: dict({ action: "opened", pull_request: dict({ number: { t: 4, n: 7 }, title }) }),
  }),
});

describe("nativeJob", () => {
  test("a job with no RelayRunner check step is routed as a pick", () => {
    expect(nativeJob([runStep])).toBeNull();
    expect(nativeJob(undefined)).toBeNull();
    expect(
      nativeJob([{ reference: { type: "repository", name: "actions/checkout", path: "" } }]),
    ).toBeNull();
  });

  test("reads check steps and their literal inputs", () => {
    expect(
      nativeJob([
        checkStep("checks/pr-title", {
          type: 2,
          map: [{ Key: "types", Value: { type: 0, lit: "feat,fix" } }],
        }),
      ]),
    ).toEqual({ kind: "checks", steps: [{ check: "pr-title", inputs: { types: "feat,fix" } }] });
    expect(nativeJob([checkStep("/Checks/PR-Title/")])).toEqual({
      kind: "checks",
      steps: [{ check: "pr-title", inputs: {} }],
    });
  });

  test("refuses a job that mixes checks with other steps", () => {
    const job = nativeJob([checkStep("checks/pr-title"), runStep]);
    expect(job?.kind).toBe("unsupported");
    expect(job?.kind === "unsupported" && job.reason).toContain("Step 2 (Run pnpm lint)");
  });

  test("refuses a check it doesn't know", () => {
    expect(nativeJob([checkStep("checks/typecheck")])).toEqual({
      kind: "unsupported",
      reason: "RelayRunner doesn't run the `typecheck` check natively yet.",
    });
  });

  test("refuses inputs that need an expression", () => {
    const job = nativeJob([
      checkStep("checks/pr-title", {
        type: 2,
        map: [{ Key: "types", Value: { type: 3, expr: "vars.TYPES" } }],
      }),
    ]);
    expect(job?.kind).toBe("unsupported");
  });
});

describe("checkConventionalTitle", () => {
  test.each([
    "feat(api): add native checks",
    "fix: handle a missing title",
    "feat(api)!: drop the old relay",
    "chore(cli): release relayrunner 0.2.0",
  ])("passes %s", (title) => {
    expect(checkConventionalTitle(title)).toEqual({ ok: true });
  });

  test.each(["Add native checks", "feat add native checks", "feat(api):add", "feat(): add", ""])(
    "fails %j",
    (title) => {
      const result = checkConventionalTitle(title);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain("isn't a Conventional Commit");
    },
  );

  test("fails a type that isn't allowed and names the allowed ones", () => {
    expect(checkConventionalTitle("feature: add checks")).toEqual({
      ok: false,
      reason:
        'The pull request title uses the type "feature". Use one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.',
    });
    expect(checkConventionalTitle("feat: add checks", ["fix", "docs"]).ok).toBe(false);
    expect(checkConventionalTitle("docs: add checks", ["fix", "docs"]).ok).toBe(true);
  });
});

describe("runChecks", () => {
  const prTitle: CheckStep = { check: "pr-title", inputs: {} };

  test("reads the title from the job's github context", async () => {
    expect(pullRequestTitle(prContext("feat: x"))).toBe("feat: x");
    expect(await runChecks([prTitle], prContext("feat(api): add native checks"), deps)).toEqual({
      ok: true,
    });
    expect((await runChecks([prTitle], prContext("Add native checks"), deps)).ok).toBe(false);
  });

  test("honours the types input", async () => {
    const docsOnly: CheckStep = { check: "pr-title", inputs: { types: "docs\nci" } };
    expect((await runChecks([docsOnly], prContext("ci: run checks"), deps)).ok).toBe(true);
    expect((await runChecks([docsOnly], prContext("feat: run checks"), deps)).ok).toBe(false);
  });

  test("fails outside a pull request event", async () => {
    const push = { github: dict({ event_name: "push", event: dict({ ref: "refs/heads/main" }) }) };
    expect(await runChecks([prTitle], push, deps)).toEqual({
      ok: false,
      reason:
        "The pr-title check reads the pull request's title, so run it on pull_request events.",
    });
  });
});

describe("nativeVerdict", () => {
  test("is null for a job that isn't native", async () => {
    expect(await nativeVerdict([runStep], prContext("feat: x"), deps)).toBeNull();
  });

  test("runs the checks and names them", async () => {
    expect(await nativeVerdict([checkStep("checks/pr-title")], prContext("feat: x"), deps)).toEqual(
      {
        checks: ["pr-title"],
        result: { ok: true },
      },
    );
  });

  test("fails a job it can't run natively with the reason", async () => {
    expect(
      await nativeVerdict([checkStep("checks/typecheck")], prContext("feat: x"), deps),
    ).toEqual({
      checks: [],
      result: { ok: false, reason: "RelayRunner doesn't run the `typecheck` check natively yet." },
    });
  });
});

describe("lint", () => {
  const sha = "0123abc";
  const dispatch = {
    github: dict({
      repository: "relayrunner/relayrunner-ci-tests",
      event_name: "workflow_dispatch",
      sha,
      event: dict({}),
    }),
  };
  const lint = (inputs: Record<string, string>): CheckStep => ({ check: "lint", inputs });

  test("lints the job's commit with its tools and paths", async () => {
    const deps = fakeDeps();
    expect(
      await runChecks([lint({ tools: "oxlint\ntypos,oxlint", paths: "src/**" })], dispatch, deps),
    ).toEqual({ ok: true });
    expect(deps.lint).toHaveBeenCalledWith(
      { repo: "relayrunner/relayrunner-ci-tests", headSha: sha },
      ["oxlint", "typos"],
      ["src/**"],
    );
  });

  test("passes on the container's verdict", async () => {
    const deps = {
      lint: vi.fn(async () => ({ ok: false, reason: "Lint failed: typos (1 error)." }) as const),
    };
    expect(await runChecks([lint({ tools: "typos" })], dispatch, deps)).toEqual({
      ok: false,
      reason: "Lint failed: typos (1 error).",
    });
  });

  test("fails on missing or unknown tools without linting", async () => {
    const deps = fakeDeps();
    expect((await runChecks([lint({})], dispatch, deps)).ok).toBe(false);
    expect(await runChecks([lint({ tools: "oxlint, eslint" })], dispatch, deps)).toEqual({
      ok: false,
      reason: expect.stringContaining("Unknown: eslint."),
    });
    expect(deps.lint).not.toHaveBeenCalled();
  });

  test("is a native check step", async () => {
    expect(
      await nativeVerdict(
        [
          checkStep("checks/lint", {
            type: 2,
            map: [{ Key: "tools", Value: { type: 0, lit: "oxlint" } }],
          }),
        ],
        dispatch,
        deps,
      ),
    ).toEqual({ checks: ["lint"], result: { ok: true } });
  });
});

describe("jobCommit", () => {
  test("prefers a pull request's head over github.sha", () => {
    const github = (event: unknown) => ({
      github: dict({ repository: "o/r", sha: "merge", event }),
    });
    expect(
      jobCommit(github(dict({ pull_request: dict({ head: dict({ sha: "head" }) }) }))),
    ).toEqual({ repo: "o/r", headSha: "head" });
    expect(jobCommit(github(dict({})))).toEqual({ repo: "o/r", headSha: "merge" });
    expect(jobCommit({})).toBeNull();
  });
});
