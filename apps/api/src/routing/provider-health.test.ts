import { describe, expect, test } from "vitest";
import {
  FIRST_BACKOFF_MS,
  healthGate,
  healthId,
  jobSignals,
  TRIAL_TIMEOUT_MS,
  updateHealth,
  type JobSignal,
  type LabelHealth,
} from "./provider-health.ts";

const MIN = 60_000;
const now = 1_000 * MIN;
const label = "depot-ubuntu-24.04";
const id = healthId("depot", label);

const missed = (queuedAgo: number): JobSignal => ({
  key: "depot",
  label,
  queuedAt: now - queuedAgo * MIN,
  startedAt: null,
  missed: true,
});
const started = (queuedAgo: number, startedAgo = queuedAgo - 1): JobSignal => ({
  key: "depot",
  label,
  queuedAt: now - queuedAgo * MIN,
  startedAt: now - startedAgo * MIN,
  missed: false,
});

const tripped: LabelHealth = {
  key: "depot",
  label,
  trippedAt: now - 20 * MIN,
  misses: 3,
  retryAt: now - 10 * MIN,
  backoffMs: FIRST_BACKOFF_MS,
  trialAt: null,
  clearedAt: null,
};

describe("updateHealth", () => {
  test("trips after 3 jobs in a row weren't picked up", () => {
    const changes = updateHealth(new Map(), [missed(20), missed(15), missed(12)], now);
    expect(changes.get(id)).toMatchObject({
      trippedAt: now,
      misses: 3,
      retryAt: now + FIRST_BACKOFF_MS,
    });
  });

  test("a job a runner started since keeps it healthy", () => {
    expect(
      updateHealth(new Map(), [missed(25), missed(20), missed(15), started(12)], now).size,
    ).toBe(0);
  });

  test("misses before someone cleared it don't trip it again", () => {
    const cleared = { ...tripped, trippedAt: null, clearedAt: now - 5 * MIN };
    const jobs = [missed(25), missed(20), missed(16)];
    expect(updateHealth(new Map([[id, cleared]]), jobs, now).size).toBe(0);
  });

  test("a runner starting a job clears it", () => {
    const changes = updateHealth(new Map([[id, tripped]]), [started(8, 2)], now);
    expect(changes.get(id)).toMatchObject({ trippedAt: null, clearedAt: now });
  });

  test("a trial job that missed doubles the wait", () => {
    const trial = { ...tripped, trialAt: now - 12 * MIN };
    const changes = updateHealth(new Map([[id, trial]]), [missed(12)], now);
    expect(changes.get(id)).toMatchObject({
      backoffMs: 2 * FIRST_BACKOFF_MS,
      retryAt: now + 2 * FIRST_BACKOFF_MS,
      trialAt: null,
    });
  });

  test("drops a healthy entry once its misses are out of the window", () => {
    const cleared = { ...tripped, trippedAt: null, clearedAt: now - 40 * MIN };
    expect(updateHealth(new Map([[id, cleared]]), [], now).get(id)).toBeNull();
  });
});

describe("healthGate", () => {
  test("skips until the wait is up, then lets one trial job through", () => {
    const waiting = { ...tripped, retryAt: now + MIN };
    expect(healthGate(waiting, now)).toEqual({ misses: 3, retryAt: now + MIN });
    expect(healthGate(tripped, now)).toBe("trial");
    expect(healthGate({ ...tripped, trialAt: now - MIN }, now)).toMatchObject({ misses: 3 });
    expect(healthGate({ ...tripped, trialAt: now - TRIAL_TIMEOUT_MS }, now)).toBe("trial");
    expect(healthGate(undefined, now)).toBe("ok");
  });
});

describe("jobSignals", () => {
  const row = {
    workspaceId: "w1",
    labels: [label],
    queuedAt: new Date(now - 15 * MIN),
    startedAt: null,
    completedAt: null,
    runnerName: null,
    conclusion: null,
  };

  test("reads hosted provider jobs, still waiting or finished without a runner", () => {
    const signals = jobSignals(
      [
        row,
        { ...row, queuedAt: new Date(now - 5 * MIN) },
        { ...row, labels: ["ubuntu-latest"] },
        { ...row, labels: [label, "linux"] },
        { ...row, conclusion: "skipped" },
        { ...row, startedAt: new Date(now - 14 * MIN), runnerName: "depot-1" },
      ],
      now,
    );
    expect(signals.get("w1")?.map(({ missed, startedAt }) => ({ missed, startedAt }))).toEqual([
      { missed: true, startedAt: null },
      { missed: false, startedAt: null },
      { missed: false, startedAt: now - 14 * MIN },
    ]);
  });
});
