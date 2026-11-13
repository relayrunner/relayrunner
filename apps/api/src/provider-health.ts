// Skipping a hosted provider's runner type while it isn't picking up jobs, kept free of Durable
// Object APIs so it can be tested on its own.
//
// A runner type (a provider and one of its labels, such as depot's `depot-ubuntu-24.04`) trips
// when its last few jobs in a workspace weren't picked up. The Router then skips that step until
// a timer runs out, lets one job through as a trial, and clears it once a runner starts. Only
// infra counts: a job that ran and failed says nothing about the runner's health.
//
// The 15-minute sweep (sweepProviderHealth) reads each workspace's recent jobs on hosted provider
// labels and hands them to the workspace's Router, which keeps the state (updateHealth).

import { hostedProviderOf, type HostedProviderId } from "@relayrunner/providers";
import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { MISSED_AFTER_MS } from "./job-times.ts";
import type { Unhealthy } from "./routing.ts";
import { errorMessage } from "./webhook-queue.ts";

// This many jobs in a row not picked up trips a runner type.
export const TRIP_AFTER = 3;
// Only jobs whose outcome is this recent count toward a trip.
export const WINDOW_MS = 30 * 60_000;
// The first wait before a trial job, doubled after each failed trial up to MAX_BACKOFF_MS.
export const FIRST_BACKOFF_MS = 10 * 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
// A trial job with no outcome after this long (cancelled before GitHub queued it, say) lets
// another one through.
export const TRIAL_TIMEOUT_MS = 30 * 60_000;

/** A runner type's state in one workspace. Healthy entries are kept only to remember `clearedAt`. */
export interface LabelHealth {
  key: HostedProviderId;
  label: string;
  // When it tripped, or null once it's healthy again.
  trippedAt: number | null;
  // How many jobs in a row weren't picked up when it tripped.
  misses: number;
  // When the next trial job may go.
  retryAt: number;
  backoffMs: number;
  // When the trial job went, or null while none is out.
  trialAt: number | null;
  // When it last recovered or someone cleared it: older jobs never trip it again.
  clearedAt: number | null;
}

/** One recent job on a hosted provider label, as the sweep read it. */
export interface JobSignal {
  key: HostedProviderId;
  label: string;
  queuedAt: number;
  // When a runner started it, or null.
  startedAt: number | null;
  // Finished or still waiting MISSED_AFTER_MS after it queued, with no runner.
  missed: boolean;
}

export const healthId = (key: string, label: string) => `${key}:${label.toLowerCase()}`;

/** A runner type back in use: it recovered, or someone pressed "Try again now". */
export const cleared = (state: LabelHealth, now: number): LabelHealth => ({
  ...state,
  trippedAt: null,
  trialAt: null,
  clearedAt: now,
});

// Appends `value` to the list at `key`.
function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// When a job's outcome was known: a runner started it, or it had waited long enough to count.
const outcomeAt = (job: JobSignal) => job.startedAt ?? job.queuedAt + MISSED_AFTER_MS;

/**
 * The next state of every runner type with recent jobs or a state: trips one whose last TRIP_AFTER
 * outcomes were all misses, clears one a runner started a job on after it tripped, and backs off
 * again when the trial job missed. Returns only the entries that changed (null: delete it).
 */
export function updateHealth(
  states: Map<string, LabelHealth>,
  jobs: JobSignal[],
  now: number,
): Map<string, LabelHealth | null> {
  const byLabel = new Map<string, JobSignal[]>();
  for (const job of jobs) append(byLabel, healthId(job.key, job.label), job);
  const changes = new Map<string, LabelHealth | null>();
  for (const id of new Set([...states.keys(), ...byLabel.keys()])) {
    const state = states.get(id);
    const outcomes = (byLabel.get(id) ?? [])
      .filter((job) => job.startedAt !== null || job.missed)
      .sort((a, b) => outcomeAt(a) - outcomeAt(b));
    if (state?.trippedAt != null) {
      const { trippedAt, trialAt } = state;
      if (outcomes.some((job) => job.startedAt !== null && job.startedAt >= trippedAt))
        changes.set(id, cleared(state, now));
      else if (trialAt !== null && outcomes.some((job) => job.missed && job.queuedAt >= trialAt)) {
        const backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
        changes.set(id, { ...state, backoffMs, retryAt: now + backoffMs, trialAt: null });
      }
      continue;
    }
    const since = Math.max(now - WINDOW_MS, state?.clearedAt ?? 0);
    const recent = outcomes.filter((job) => outcomeAt(job) > since);
    const last = recent.slice(-TRIP_AFTER);
    if (last.length === TRIP_AFTER && last.every((job) => job.missed)) {
      const [first] = last;
      changes.set(id, {
        key: first.key,
        label: first.label,
        trippedAt: now,
        misses: recent.length - recent.findLastIndex((job) => !job.missed) - 1,
        retryAt: now + FIRST_BACKOFF_MS,
        backoffMs: FIRST_BACKOFF_MS,
        trialAt: null,
        clearedAt: state?.clearedAt ?? null,
      });
    } else if (state && (state.clearedAt ?? 0) < now - WINDOW_MS) changes.set(id, null);
  }
  return changes;
}

/** What a pick does with a runner type: take it, take it as the trial job, or skip it. */
export type HealthGate = "ok" | "trial" | Unhealthy;

export function healthGate(state: LabelHealth | undefined, now: number): HealthGate {
  if (state?.trippedAt == null) return "ok";
  if (now >= state.retryAt && (state.trialAt === null || now - state.trialAt >= TRIAL_TIMEOUT_MS))
    return "trial";
  return { misses: state.misses, retryAt: state.retryAt };
}

type SweepRow = {
  workspaceId: string;
  labels: string[];
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  runnerName: string | null;
  conclusion: string | null;
};

/** The sweep's rows as signals: single-label jobs on a hosted provider's label. */
export function jobSignals(rows: SweepRow[], now: number): Map<string, JobSignal[]> {
  const byWorkspace = new Map<string, JobSignal[]>();
  for (const row of rows) {
    if (row.labels.length !== 1 || !row.queuedAt || row.conclusion === "skipped") continue;
    const [label] = row.labels;
    const key = hostedProviderOf(label);
    if (!key) continue;
    const queuedAt = row.queuedAt.getTime();
    const started = row.startedAt !== null && row.runnerName !== null;
    const signal: JobSignal = {
      key,
      label,
      queuedAt,
      startedAt: started ? row.startedAt!.getTime() : null,
      missed: !started && (row.completedAt?.getTime() ?? now) - queuedAt >= MISSED_AFTER_MS,
    };
    append(byWorkspace, row.workspaceId, signal);
  }
  return byWorkspace;
}

/**
 * Every 15 minutes: each workspace's jobs on hosted provider labels from the last WINDOW_MS (plus
 * the wait it takes to count as missed), handed to its Router.
 */
export async function sweepProviderHealth(env: Env, now = Date.now()) {
  const db = createDb(env.DB);
  const table = schema.jobTiming;
  const since = new Date(now - WINDOW_MS - MISSED_AFTER_MS);
  const rows = await db
    .select({
      workspaceId: schema.workspace.id,
      labels: table.labels,
      queuedAt: table.queuedAt,
      startedAt: table.startedAt,
      completedAt: table.completedAt,
      runnerName: table.runnerName,
      conclusion: table.conclusion,
    })
    .from(table)
    .innerJoin(schema.workspace, eq(schema.workspace.installationId, table.installationId))
    .where(
      and(
        // Implied by queuedAt, but lets D1 use the completed_at index and the unfinished-jobs one.
        or(gte(table.completedAt, since), isNull(table.completedAt)),
        gte(table.queuedAt, since),
        sql`json_array_length(${table.labels}) = 1`,
      ),
    );
  const byWorkspace = jobSignals(rows, now);
  const results = await Promise.allSettled(
    [...byWorkspace].map(([workspaceId, jobs]) =>
      env.ROUTER.getByName(workspaceId).updateHealth(jobs, now),
    ),
  );
  for (const result of results)
    if (result.status === "rejected")
      console.warn(
        JSON.stringify({
          msg: "provider health update failed",
          error: errorMessage(result.reason),
        }),
      );
}
