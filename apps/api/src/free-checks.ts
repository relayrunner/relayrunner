// What the free checks saved: each check run the GitHub App posts (src/pr-title-check.ts), and each
// lint run in the Checks App's container (src/durable-objects/lint-runner.ts), is a job that never
// ran on an Actions runner. Run as a workflow, it would be a short job on ubuntu-latest, billed as
// at least a whole minute. Each one is logged as a `check.completed` Activity event, and the Usage
// and Activity pages sum them.

import type { ActivityEvent } from "@relayrunner/activity";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { recordEvent } from "./activity.ts";
import { type Db, schema } from "./db/index.ts";
import { createCheckRun } from "./github-app.ts";
import { workspaceIdForInstallation } from "./installations.ts";
import { loadPriceBook } from "./prices.ts";
import { cents, classRate, DAY_MS, pricePeriods, RUNNER_LABELS, rateFor } from "./job-timings.ts";

const table = schema.activityEvent;

// The runner a workflow running the same check would ask for. GitHub bills it one minute a run.
const FREE_CHECK_RUNNER = "linux-2-core" as const;

export type FreeCheck = Extract<ActivityEvent, { type: "check.completed" }>["data"];

/**
 * Posts a free check's run on a pull request and logs it, so every check the App posts counts
 * toward the minutes saved.
 */
export async function postFreeCheck(
  db: Db,
  token: string,
  installationId: number,
  pull: { repository: { id: number; fullName: string }; number: number },
  check: Parameters<typeof createCheckRun>[2],
) {
  const { url } = await createCheckRun(token, pull.repository.fullName, check);
  await recordFreeCheck(db, installationId, {
    check: check.name,
    repository: pull.repository.fullName,
    repositoryId: pull.repository.id,
    pullRequest: pull.number,
    headSha: check.headSha,
    conclusion: check.conclusion,
    url,
  });
}

/**
 * Logs a posted check run in the installation's workspace. Skipped when the installation has no
 * row or no workspace.
 */
export async function recordFreeCheck(db: Db, installationId: number, data: FreeCheck) {
  const workspaceId = await workspaceIdForInstallation(db, installationId);
  if (!workspaceId) return false;
  await recordEvent(db, { workspaceId, type: "check.completed", data });
  return true;
}

/**
 * Logs a free check in the workspace of the main App's installation on `repository`, for checks
 * that know the repo only by name: the Checks App's lint runs (its installation has no row) and
 * native check jobs. Skipped when RelayRunner doesn't know the repo or it isn't in a workspace.
 */
export async function recordRepoCheck(
  db: Db,
  repository: string,
  data: Omit<FreeCheck, "repository" | "repositoryId">,
) {
  const [repo] = await db
    .select({
      id: schema.githubRepository.id,
      workspaceId: schema.workspace.id,
    })
    .from(schema.githubRepository)
    .innerJoin(
      schema.workspace,
      eq(schema.workspace.installationId, schema.githubRepository.installationId),
    )
    .where(
      and(
        sql`lower(${schema.githubRepository.fullName}) = ${repository.toLowerCase()}`,
        isNull(schema.githubRepository.removedAt),
      ),
    )
    .limit(1);
  if (!repo?.workspaceId) return false;
  await recordEvent(db, {
    workspaceId: repo.workspaceId,
    type: "check.completed",
    data: { ...data, repository, repositoryId: repo.id },
  });
  return true;
}

export interface FreeCheckSavings {
  days: number;
  /** The runner and rate each check is priced at. */
  runner: { label: string; perMinute: number };
  /** Check runs, each one billed minute saved, public repos included. */
  checks: number;
  /** USD, after free public-repo minutes. */
  savedCost: number;
  /** Each kind of check ("PR title", "Lint"), the most runs first. */
  byCheck: { check: string; checks: number; savedCost: number }[];
  /** Repos with the most checks first. */
  byRepository: {
    repository: string;
    private: boolean | null;
    checks: number;
    savedCost: number;
  }[];
}

/** The workspace's free check runs from the last `days` days, and the money they saved. */
export async function freeCheckSavings(
  db: Db,
  workspaceId: string,
  days = 30,
): Promise<FreeCheckSavings> {
  const now = Date.now();
  const since = new Date(now - days * DAY_MS);
  const book = await loadPriceBook(db, now);
  const prices = pricePeriods(book, table.occurredAt, since.getTime(), now);
  const repositoryId = sql<number>`json_extract(${table.data}, '$.repositoryId')`;
  const check = sql<string>`json_extract(${table.data}, '$.check')`;
  const rows = await db
    .select({
      period: prices.period,
      check,
      repositoryId,
      // Its current name when mirrored, so a renamed repo's checks add up under one name.
      repository: sql<string>`coalesce(${schema.githubRepository.fullName}, json_extract(${table.data}, '$.repository'))`,
      private: schema.githubRepository.private,
      checks: sql<number>`count(*)`,
    })
    .from(table)
    .leftJoin(schema.githubRepository, eq(schema.githubRepository.id, repositoryId))
    .where(
      and(
        eq(table.workspaceId, workspaceId),
        eq(table.type, "check.completed"),
        gte(table.occurredAt, since),
      ),
    )
    .groupBy(...prices.groupBy, check, repositoryId, schema.githubRepository.private);

  type Sum = { checks: number; savedCost: number };
  const repos = new Map<number, FreeCheckSavings["byRepository"][number]>();
  const kinds = new Map<string, FreeCheckSavings["byCheck"][number]>();
  const sum = <K, T extends Sum>(
    map: Map<K, T>,
    key: K,
    empty: T,
    checks: number,
    cost: number,
  ) => {
    let row = map.get(key);
    if (!row) map.set(key, (row = empty));
    row.checks += checks;
    row.savedCost += cost;
  };
  for (const row of rows) {
    const checks = Number(row.checks);
    const cost =
      checks * rateFor(book, FREE_CHECK_RUNNER, row.private, prices.at(Number(row.period)));
    const repository = {
      repository: row.repository,
      private: row.private,
      checks: 0,
      savedCost: 0,
    };
    sum(repos, row.repositoryId, repository, checks, cost);
    sum(kinds, row.check, { check: row.check, checks: 0, savedCost: 0 }, checks, cost);
  }
  // Rounded once, then sorted with the most runs first.
  const ranked = <K, T extends Sum>(map: Map<K, T>) =>
    [...map.values()]
      .map((row) => ({ ...row, savedCost: cents(row.savedCost) }))
      .sort((a, b) => b.checks - a.checks || b.savedCost - a.savedCost);
  const byRepository = ranked(repos);
  return {
    days,
    runner: {
      label: RUNNER_LABELS[FREE_CHECK_RUNNER],
      perMinute: classRate(book, FREE_CHECK_RUNNER, now),
    },
    checks: byRepository.reduce((total, repo) => total + repo.checks, 0),
    savedCost: cents(byRepository.reduce((total, repo) => total + repo.savedCost, 0)),
    byCheck: ranked(kinds),
    byRepository: byRepository.slice(0, 10),
  };
}
