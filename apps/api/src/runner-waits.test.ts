import { beforeAll, describe, expect, test } from "vitest";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { failedStep, recordJobTiming } from "./job-timings.ts";
import { waitBucket, waitRunner } from "./runner-waits.ts";
import * as testing from "./testing.ts";

const DAY_MS = 86_400_000;

let env: Env;
let jobIds = 0;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

async function workspace() {
  const { cookie } = await testing.signIn(env);
  const slug = `waits-${crypto.randomUUID().slice(0, 8)}`;
  return (await testing.createWorkspace(env, cookie, slug, slug)).workspace;
}

type Job = {
  labels?: string[];
  runnerGroupName?: string | null;
  runnerName?: string | null;
  waitMs?: number;
  completedAt?: number;
  conclusion?: string;
  ranSteps?: boolean | null;
  id?: number;
};

async function deliver(installationId: number, job: Job = {}) {
  const id = job.id ?? (jobIds += 1);
  const completedAt = job.completedAt ?? Date.now();
  const startedAt = completedAt - 30_000;
  await recordJobTiming(createDb(env.DB), {
    event: "workflow_job",
    deliveryId: `wait-${id}`,
    action: "completed",
    installationId,
    receivedAt: new Date().toISOString(),
    repository: { id: installationId * 10, fullName: "acme/app" },
    job: {
      id,
      runId: id,
      runAttempt: 1,
      name: "test",
      workflowName: "CI",
      status: "completed",
      conclusion: job.conclusion ?? "success",
      labels: job.labels ?? ["ubuntu-latest"],
      headBranch: "main",
      headSha: "abc",
      runnerName: job.runnerName === undefined ? "runner" : job.runnerName,
      runnerGroupName: job.runnerGroupName === undefined ? "GitHub Actions" : job.runnerGroupName,
      createdAt: new Date(startedAt - (job.waitMs ?? 5_000)).toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      ranSteps: job.ranSteps ?? true,
      steps: [],
    },
  });
  return id;
}

function waitsFor(installationId: number) {
  return createDb(env.DB).query.runnerWaitDay.findMany({
    where: (t, { eq }) => eq(t.installationId, installationId),
    orderBy: (t, { asc }) => [asc(t.provider), asc(t.platform), asc(t.vcpus)],
  });
}

describe("runner waits", () => {
  test("keys a runner by provider, platform and vCPUs, never its label", () => {
    expect(waitRunner(["ubuntu-latest"], "GitHub Actions")).toEqual({
      provider: "github",
      platform: "linux",
      vcpus: 2,
    });
    expect(waitRunner(["windows-11-arm"], "GitHub Actions")).toMatchObject({
      platform: "windows-arm",
    });
    expect(waitRunner(["macos-latest"], "GitHub Actions")).toMatchObject({ platform: "macos" });
    expect(waitRunner(["blacksmith-4vcpu-ubuntu-2404-arm"], null)).toEqual({
      provider: "blacksmith",
      platform: "arm",
      vcpus: 4,
    });
    expect(waitRunner(["depot-ubuntu-24.04-8"], null)).toEqual({
      provider: "depot",
      platform: "linux",
      vcpus: 8,
    });
    // A larger runner's name is someone's own, so it says nothing about the platform.
    expect(waitRunner(["acme-windows-big"], "GitHub Actions")).toMatchObject({
      provider: "github",
      platform: "other",
    });
    // Runners people host themselves aren't counted.
    expect(waitRunner(["self-hosted", "linux"], "Default")).toBeNull();
    expect(waitRunner(["my-custom-label"], null)).toBeNull();
  });

  test("buckets a wait under the first limit it's below", () => {
    expect(waitBucket(0)).toBe("under10s");
    expect(waitBucket(10_000)).toBe("under30s");
    expect(waitBucket(59_999)).toBe("under1m");
    expect(waitBucket(60 * 60_000)).toBe("over15m");
  });

  test("counts each finished hosted job once, in its day and wait bucket", async () => {
    const { installationId } = await workspace();
    const day = Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS;
    const id = await deliver(installationId, { waitMs: 4_000, completedAt: day + 60_000 });
    // A redelivered `completed` changes nothing.
    await deliver(installationId, { id, waitMs: 4_000, completedAt: day + 60_000 });
    await deliver(installationId, { waitMs: 90_000, completedAt: day + 120_000 });
    await deliver(installationId, {
      waitMs: 20_000,
      completedAt: day + 180_000,
      conclusion: "failure",
      ranSteps: false,
    });
    await deliver(installationId, {
      labels: ["blacksmith-2vcpu-ubuntu-2404"],
      runnerGroupName: null,
      waitMs: 2_000,
      completedAt: day,
    });
    // Not counted: no runner took it, and a self-hosted runner.
    await deliver(installationId, { runnerName: null, completedAt: day });
    await deliver(installationId, {
      labels: ["self-hosted"],
      runnerGroupName: "Default",
      completedAt: day,
    });

    const rows = await waitsFor(installationId);
    expect(rows).toMatchObject([
      { provider: "blacksmith", platform: "linux", vcpus: 2, jobs: 1, under10s: 1 },
      {
        day: new Date(day),
        provider: "github",
        platform: "linux",
        vcpus: 2,
        jobs: 3,
        waitMs: 114_000,
        under10s: 1,
        under30s: 1,
        under2m: 1,
        runnerFailures: 1,
      },
    ]);
  });

  test("names the first failed step", () => {
    expect(
      failedStep([
        { name: "Set up job", number: 1, conclusion: "success" },
        { name: "Run tests", number: 3, conclusion: "failure" },
        { name: "Lint", number: 4, conclusion: "failure" },
      ]),
    ).toBe("3. Run tests");
    expect(failedStep([{ name: "Build", number: 2, conclusion: "success" }])).toBeNull();
  });
});
