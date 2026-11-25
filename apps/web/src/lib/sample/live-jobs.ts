// Live jobs for the dev preview (lib/sample/answers.ts), like GET /api/runs/live, matching
// SAMPLE_MACHINES.
import type { MachineJob } from "../machines.ts";
import type { LiveJob, LiveJobs } from "../live-jobs.ts";
import { sampleParam } from "./param.ts";

const MIN = 60_000;

/** Example live jobs for `VITE_AUTH_DISABLED=true` dev builds, matching SAMPLE_MACHINES. */
export function sampleLiveJobs(now = Date.now()): LiveJobs {
  const job = (rest: Partial<LiveJob> & Pick<LiveJob, "id" | "name" | "environment">): LiveJob => ({
    repositoryId: 1,
    repository: "acme/app",
    runId: rest.id,
    runAttempt: 1,
    workflow: "CI",
    labels: ["ubuntu-latest"],
    queuedAt: null,
    startedAt: null,
    typical: null,
    ...rest,
  });
  return {
    environments: [
      {
        key: "github:linux-2-core",
        label: "ubuntu-latest",
        detail: "GitHub-hosted",
      },
      { key: "machine:sample", label: "ada-mbp", detail: "" },
      { key: "machine:sample-mini", label: "studio-mini", detail: "" },
      { key: "self-hosted:default", label: "Self-hosted", detail: "" },
    ],
    running: [
      job({
        id: 101,
        name: "test (macos)",
        environment: "machine:sample",
        labels: ["rr-0123456789ab"],
        startedAt: now - 4 * MIN - 57_000,
        typical: {
          medianMs: 6 * MIN + 20_000,
          p90Ms: 7 * MIN + 30_000,
          samples: 38,
        },
      }),
      job({
        id: 102,
        name: "lint",
        environment: "github:linux-2-core",
        startedAt: now - 73_000,
        typical: { medianMs: 41_000, p90Ms: 55_000, samples: 50 },
      }),
    ],
    // The Product Hunt variant shows an empty queue.
    queued:
      sampleParam() === "ph"
        ? []
        : [
            job({
              id: 103,
              name: "build (windows)",
              workflow: "Release",
              environment: "self-hosted:default",
              labels: ["self-hosted", "windows"],
              queuedAt: now - 12 * MIN - 4_000,
            }),
            job({
              id: 104,
              name: "e2e",
              environment: "machine:sample-mini",
              labels: ["rr-89abcdef0123"],
              queuedAt: now - 2 * MIN - 31_000,
            }),
            job({
              id: 105,
              name: "typecheck",
              environment: "github:linux-2-core",
              queuedAt: now - 9_000,
            }),
          ],
  };
}

/** The sample machine's running job, the first of sampleLiveJobs' running jobs. */
export function sampleMachineJob(): MachineJob {
  const job = sampleLiveJobs().running[0]!;
  return {
    repository: job.repository,
    workflow: job.workflow,
    name: job.name,
    url: `https://github.com/${job.repository}/actions/runs/${job.runId}/job/${job.id}`,
    startedAt: new Date(job.startedAt!).toISOString(),
  };
}
