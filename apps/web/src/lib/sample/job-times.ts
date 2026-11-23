// Job times for the dev preview (lib/sample/answers.ts), like GET /api/job-times.
import type { Stat } from "@relayrunner/api-types";
import type { JobTimesReport } from "../job-times.ts";
import { hasTrend } from "./shared.ts";

/** A made-up Stat for the sample reports: `samples` successful runs around `medianS` seconds. */
export function sampleStat(
  medianS: number,
  samples: number,
  runs = samples,
  trend: number | null = null,
): Stat {
  return {
    runs,
    successes: Math.round(runs * 0.96),
    samples: Math.min(samples, 50),
    confidence: samples === 0 ? "none" : samples < 5 ? "few" : samples < 20 ? "low" : "ok",
    medianMs: medianS * 1000,
    p90Ms: medianS * 1300,
    waitMs: samples ? 6000 : null,
    trend,
  };
}

/** Example report for `VITE_AUTH_DISABLED=true` dev builds, which have no API. */
export function sampleJobTimes(days: number): JobTimesReport {
  const stat = sampleStat;
  const linux = "github:linux-2-core";
  const mac = "machine:sample";
  const container = "container";
  const macos = "github:macos";
  const blacksmith = "blacksmith:blacksmith-4vcpu-ubuntu-2404";
  return {
    days,
    trend: hasTrend(days),
    sampleCap: 50,
    fewRuns: 5,
    minSharedJobs: 3,
    baseline: linux,
    environments: [
      {
        key: linux,
        label: "ubuntu-latest",
        detail: "GitHub-hosted",
        size: { vcpus: 2, memoryGb: 8 },
        stat: stat(108, 50, 412),
        missed: 0,
        versus: null,
      },
      {
        key: mac,
        label: "Ada's MacBook Pro",
        detail: "MacBook Pro · Apple M3 Max",
        machine: { source: "connect", kind: "laptop", model: "MacBook Pro" },
        stat: stat(41, 50, 198),
        missed: 2,
        versus: { ratio: 0.37, sharedJobs: 3 },
      },
      {
        key: "machine:sample-mini",
        label: "studio-mini",
        detail: "Mac mini · Apple M4 Pro",
        machine: { source: "connect", kind: "desktop", model: "Mac mini" },
        stat: stat(23, 23, 171),
        missed: 0,
        versus: null,
      },
      {
        key: "machine:sample-github",
        label: "build-01",
        detail: "",
        machine: { source: "github", kind: null, model: null },
        stat: stat(64, 50, 240),
        missed: 0,
        versus: null,
      },
      {
        key: "self-hosted:default",
        label: "Self-hosted",
        detail: "",
        stat: stat(88, 50, 260),
        missed: 0,
        versus: null,
      },
      {
        key: container,
        label: "Cloudflare Container",
        detail: "standard-1",
        size: { vcpus: 0.5, memoryGb: 4 },
        stat: stat(19, 50, 61),
        missed: 0,
        versus: { ratio: 1.03, sharedJobs: 3 },
      },
      {
        key: blacksmith,
        label: "blacksmith-4vcpu-ubuntu-2404",
        detail: "Blacksmith",
        size: { vcpus: 4, memoryGb: 16 },
        stat: stat(56, 31, 33),
        missed: 0,
        versus: { ratio: 0.55, sharedJobs: 4 },
      },
      {
        key: macos,
        label: "macOS",
        detail: "GitHub-hosted",
        stat: stat(400, 9),
        missed: 0,
        versus: null,
      },
    ],
    workflows: [
      {
        repositoryId: 1,
        repository: "acme/app",
        workflow: "CI",
        wall: stat(214, 50, 162, 0.12),
        usd: 0.034,
        environments: [linux, mac, container, blacksmith],
        fastest: { environment: mac, ratio: 0.42 },
        runMs: 162 * 448_000,
        spentUsd: 4.86,
        jobs: [
          {
            name: "test",
            byEnvironment: { [linux]: stat(190, 50, 150, 0.18), [mac]: stat(81, 44) },
            legs: [
              {
                name: "test (node 22)",
                byEnvironment: { [linux]: stat(182, 50), [mac]: stat(78, 15) },
              },
              {
                name: "test (node 24)",
                byEnvironment: { [linux]: stat(192, 50), [mac]: stat(81, 16) },
              },
            ],
          },
          {
            name: "typecheck",
            byEnvironment: {
              [linux]: stat(92, 50),
              [mac]: stat(38, 40),
              [container]: stat(168, 7),
            },
          },
          {
            name: "lint",
            byEnvironment: {
              [linux]: stat(41, 50, 50, -0.31),
              [mac]: stat(12, 31),
              [container]: stat(24, 22),
            },
          },
          { name: "build", byEnvironment: { [linux]: stat(125, 50), [mac]: stat(52, 3) } },
        ],
      },
      {
        repositoryId: 1,
        repository: "acme/app",
        workflow: "Release",
        wall: stat(262, 9, 10),
        usd: 0.4,
        environments: [macos, mac],
        fastest: null,
        runMs: 10 * 400_000,
        spentUsd: 4.0,
        jobs: [
          { name: "build-macos", byEnvironment: { [mac]: stat(235, 12), [macos]: stat(400, 9) } },
        ],
      },
    ],
  };
}
