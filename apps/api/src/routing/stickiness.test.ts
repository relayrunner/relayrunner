import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import {
  REMOVED_AFTER,
  SETTLE_MS,
  type StickinessRun,
  stickinessOf,
  TRIAL_IDLE_MS,
  workspaceStickiness,
} from "./stickiness.ts";
import * as testing from "../testing.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-14T22:00:00Z");

let runIds = 0;

/** A first-attempt run `hoursAgo` before NOW. */
function run(
  hoursAgo: number,
  branch: string,
  relayed: boolean,
  extra: Partial<StickinessRun> = {},
) {
  runIds += 1;
  const at = NOW - hoursAgo * HOUR;
  return {
    installationId: 1,
    repositoryId: 10,
    repository: "acme/app",
    workflowPath: ".github/workflows/ci.yml",
    workflowName: "CI",
    branch,
    event: branch === "main" ? "push" : "pull_request",
    defaultBranch: "main",
    startedAt: at,
    seenAt: at,
    finishedAt: at,
    relayed,
    ...extra,
  } satisfies StickinessRun;
}

const stateOf = (runs: StickinessRun[], now = NOW) => stickinessOf(runs, now).get(1);

describe("stickinessOf", () => {
  test("a repo that never relayed has no state", () => {
    expect(stateOf([run(5, "main", false), run(4, "feature", false)])).toBeUndefined();
  });

  test("a relay only on the connect PR is trying, however busy the rest of the repo is", () => {
    const state = stateOf([
      run(30, "main", false),
      run(20, "relayrunner", true),
      run(19, "main", false),
      run(18, "fix-login", false),
      run(17, "main", false),
      run(16, "main", false),
      run(15, "relayrunner", true),
    ]);
    expect(state).toMatchObject({ state: "trying", branch: "relayrunner" });
    expect(state?.since).toBe(new Date(NOW - 20 * HOUR).toISOString());
  });

  test("a trial idle for 7 days is abandoned", () => {
    const relayAt = NOW - TRIAL_IDLE_MS - HOUR;
    const state = stateOf([
      { ...run(0, "relayrunner", true), startedAt: relayAt, seenAt: relayAt },
      run(2, "main", false),
    ]);
    expect(state).toMatchObject({ state: "trial_abandoned", branch: "relayrunner" });
    expect(state?.since).toBe(new Date(relayAt + TRIAL_IDLE_MS).toISOString());
  });

  test("a relay on the default branch adopts", () => {
    const state = stateOf([run(20, "relayrunner", true), run(10, "main", true)]);
    expect(state).toMatchObject({ state: "adopted", branch: null });
    expect(state?.since).toBe(new Date(NOW - 10 * HOUR).toISOString());
  });

  test("a relay on a second branch adopts a workflow that only runs on pull requests", () => {
    const state = stateOf([run(20, "relayrunner", true), run(10, "new-feature", true)]);
    expect(state?.state).toBe("adopted");
  });

  test("a job routed to GitHub is still relayed: the run had a pick", () => {
    // Where the pick sent the job doesn't reach this code at all: relayed means a pick ran.
    const state = stateOf([run(20, "main", true), run(10, "main", true), run(5, "main", true)]);
    expect(state?.state).toBe("adopted");
  });

  test(`${REMOVED_AFTER} runs on the default branch without the relay remove it`, () => {
    const runs = [run(20, "main", true), run(10, "main", false), run(9, "main", false)];
    expect(stateOf(runs)?.state).toBe("adopted");
    const third = run(8, "main", false);
    const state = stateOf([...runs, third]);
    expect(state).toMatchObject({ state: "removed", runsWithout: 3 });
    expect(state?.since).toBe(new Date(third.seenAt + SETTLE_MS).toISOString());
  });

  test("events the relay never ran on don't count against it", () => {
    // Routes its pull requests; pushes to main run the same workflow without a pick.
    const relayed = [run(30, "relayrunner", true), run(20, "feature", true)];
    const pushes = [run(10, "main", false), run(9, "main", false), run(8, "main", false)];
    expect(stateOf([...relayed, ...pushes])?.state).toBe("adopted");
    // Pull requests without it still count.
    const prs = [run(7, "fresh-1", false), run(6, "fresh-2", false), run(5, "fresh-3", false)];
    expect(stateOf([...relayed, ...pushes, ...prs])).toMatchObject({
      state: "removed",
      runsWithout: 3,
    });
  });

  test("runs still going, skipped or cancelled don't count against it", () => {
    const state = stateOf([
      run(20, "main", true),
      run(10, "main", false, { finishedAt: null }),
      run(9, "main", false, { finishedAt: null }),
      run(8, "main", false, { finishedAt: null }),
      run(7, "main", false),
      run(6, "main", false),
    ]);
    expect(state).toMatchObject({ state: "adopted" });
  });

  test("a run that finishes long after we stored it tips the state when it finishes", () => {
    const third = run(8, "main", false, { finishedAt: NOW - 2 * HOUR });
    const state = stateOf([
      run(20, "main", true),
      run(10, "main", false),
      run(9, "main", false),
      third,
    ]);
    expect(state).toMatchObject({ state: "removed", runsWithout: 3 });
    expect(state?.since).toBe(new Date(NOW - 2 * HOUR + SETTLE_MS).toISOString());
  });

  test("a slow run finishing after a later one has tipped it doesn't move when it flipped", () => {
    const runs = [
      run(20, "main", true),
      run(10, "main", false),
      run(9, "main", false),
      run(8, "main", false, { finishedAt: null }),
      run(7, "main", false),
    ];
    const flipped = stateOf(runs)?.since;
    expect(flipped).toBe(new Date(NOW - 7 * HOUR + SETTLE_MS).toISOString());
    runs[3] = { ...runs[3]!, finishedAt: NOW - HOUR };
    expect(stateOf(runs)).toMatchObject({ state: "removed", since: flipped, runsWithout: 4 });
  });

  test("branches cut before the merge don't count against it", () => {
    const state = stateOf([
      run(40, "old-feature", false),
      run(30, "relayrunner", true),
      run(20, "main", true),
      run(10, "old-feature", false),
      run(9, "old-feature", false),
      run(8, "old-feature", false),
    ]);
    expect(state?.state).toBe("adopted");
  });

  test("branches first seen after adoption do count", () => {
    const state = stateOf([
      run(30, "relayrunner", true),
      run(20, "main", true),
      run(10, "fresh-1", false),
      run(9, "fresh-2", false),
      run(8, "fresh-3", false),
    ]);
    expect(state?.state).toBe("removed");
  });

  test("relaying again puts it back to adopted", () => {
    const state = stateOf([
      run(20, "main", true),
      run(10, "main", false),
      run(9, "main", false),
      run(8, "main", false),
      run(2, "main", true),
    ]);
    expect(state?.state).toBe("adopted");
  });

  test("dropping one workflow while another still relays stays adopted", () => {
    const deploy = { workflowPath: ".github/workflows/deploy.yml", workflowName: "Deploy" };
    const state = stateOf([
      run(20, "main", true),
      run(19, "main", true, deploy),
      run(10, "main", false, deploy),
      run(9, "main", false, deploy),
      run(8, "main", false, deploy),
      run(7, "main", true),
    ]);
    expect(state).toMatchObject({ state: "adopted", workflow: "CI" });
  });

  test("the workspace is removed only once every adopted workflow is", () => {
    const deploy = { workflowPath: ".github/workflows/deploy.yml", workflowName: "Deploy" };
    const state = stateOf([
      run(30, "main", true),
      run(29, "main", true, deploy),
      run(20, "main", false),
      run(19, "main", false),
      run(18, "main", false),
      run(10, "main", false, deploy),
      run(9, "main", false, deploy),
      run(8, "main", false, deploy),
    ]);
    expect(state).toMatchObject({ state: "removed", workflow: "Deploy" });
  });

  test("each pilot workflow on its own validation branch is still trying", () => {
    const ios = { workflowPath: ".github/workflows/ios.yml", workflowName: "iOS pilot" };
    const state = stateOf([
      run(20, "ci-validation", true),
      run(10, "validation/ios", true, ios),
      run(9, "validation/ios", true, ios),
    ]);
    expect(state?.state).toBe("trying");
  });

  test("runs stored before paths match newer runs of the same name", () => {
    const state = stateOf([
      run(20, "relayrunner", true, { workflowPath: null }),
      run(10, "main", true),
    ]);
    expect(state?.state).toBe("adopted");
  });

  test("without a stored default branch, main or master is the default", () => {
    const state = stateOf([
      run(20, "relayrunner", true, { defaultBranch: null }),
      run(10, "master", true, { defaultBranch: null }),
    ]);
    expect(state?.state).toBe("adopted");
  });

  test("runs too new to have their pick recorded don't count yet", () => {
    const runs = [run(20, "main", true), run(10, "main", false), run(9, "main", false)];
    const fresh = { ...run(0, "main", false), seenAt: NOW - SETTLE_MS / 2 };
    expect(stateOf([...runs, fresh])?.state).toBe("adopted");
  });
});

describe("workspaceStickiness", () => {
  let env: Env;

  beforeAll(async () => {
    env = await testing.createTestEnv();
  });

  test("reads first-attempt runs and their picks", async () => {
    const { cookie } = await testing.signIn(env);
    const { workspace } = await testing.createWorkspace(env, cookie, "Sticky", "sticky");
    const db = createDb(env.DB);
    const [row] = await db
      .select({ installationId: schema.workspace.installationId })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, workspace.id));
    const installationId = row!.installationId;
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR);
    const runs = [
      { id: 501, branch: "relayrunner", hoursAgo: 20 },
      { id: 502, branch: "main", hoursAgo: 10 },
    ];
    for (const r of runs) {
      await db.insert(schema.workflowRun).values({
        id: r.id,
        runAttempt: 1,
        installationId,
        repositoryId: 77,
        repositoryFullName: "acme/sticky",
        workflowName: "CI",
        workflowPath: ".github/workflows/ci.yml",
        defaultBranch: "main",
        event: "pull_request",
        headBranch: r.branch,
        headSha: "abc",
        status: "completed",
        runStartedAt: at(r.hoursAgo),
        githubUpdatedAt: at(r.hoursAgo),
        createdAt: at(r.hoursAgo),
      });
      await db.insert(schema.workflowJob).values({
        id: r.id * 10,
        installationId,
        repositoryId: 77,
        repositoryFullName: "acme/sticky",
        runId: r.id,
        runAttempt: 1,
        kind: "pick",
        name: "relay",
        labels: ["relayrunner"],
        headSha: "abc",
        status: "completed",
        githubCreatedAt: at(r.hoursAgo),
      });
    }
    // Runs on main without a pick whose jobs never ran: none of them counts.
    const unrun = [
      { id: 503, status: "completed", conclusion: "skipped", hoursAgo: 5 },
      { id: 504, status: "completed", conclusion: "cancelled", hoursAgo: 4 },
      { id: 505, status: "in_progress", conclusion: null, hoursAgo: 3 },
      { id: 506, status: "completed", conclusion: "startup_failure", hoursAgo: 2 },
      { id: 507, status: "completed", conclusion: "action_required", hoursAgo: 1 },
    ];
    for (const r of unrun) {
      await db.insert(schema.workflowRun).values({
        id: r.id,
        runAttempt: 1,
        installationId,
        repositoryId: 77,
        repositoryFullName: "acme/sticky",
        workflowName: "CI",
        workflowPath: ".github/workflows/ci.yml",
        defaultBranch: "main",
        event: "push",
        headBranch: "main",
        headSha: "abc",
        status: r.status,
        conclusion: r.conclusion,
        runStartedAt: at(r.hoursAgo),
        githubUpdatedAt: at(r.hoursAgo),
        createdAt: at(r.hoursAgo),
      });
    }
    const states = await workspaceStickiness(db, now);
    expect(states.get(workspace.id)).toMatchObject({
      state: "adopted",
      repository: "acme/sticky",
      workflow: "CI",
    });
  });
});
