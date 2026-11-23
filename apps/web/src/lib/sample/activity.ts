// The Activity log's example entries for the dev preview (lib/sample/answers.ts).
import type {
  ActivityItem,
  ActivityJob,
  ActivityOptions,
  ActivityPage,
  ActivityQuery,
  ActivityResult,
} from "@/lib/activity";
import { relayInputs } from "@relayrunner/runner-order";

/** The Activity log's example entries, narrowed as the API would by `query`. */
export function sampleActivityPage(query: ActivityQuery): ActivityPage {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const runs = "https://github.com/relayrunner/relayrunner-ci-tests/actions/runs";
  const atticus = { login: "atticoos", member: { id: "u1", name: "Atticus White" } };
  const zach = { login: "zach", member: { id: "u2", name: "Zach Ross" } };
  const job = (id: number, minutesAgo: number, rest: Partial<ActivityJob>): ActivityJob => ({
    id,
    repositoryId: 1,
    repository: "relayrunner/relayrunner-ci-tests",
    private: true,
    runId: id * 10,
    runAttempt: 1,
    workflow: "RelayRunner dev",
    name: "test",
    runner: { type: "github", label: "ubuntu-latest" },
    walk: null,
    runnerName: null,
    branch: "main",
    sha: "abc123",
    status: "queued",
    conclusion: null,
    createdAt: at(minutesAgo),
    startedAt: null,
    completedAt: null,
    url: `${runs}/${id * 10}/job/${id}`,
    runUrl: `${runs}/${id * 10}`,
    starters: { startedBy: atticus, rerunBy: null },
    ...rest,
  });
  const mac = { id: "m1", name: "Atticuss-MacBook-Pro.local" };
  const relay = relayInputs({ machine: ["self-hosted"], github: ["ubuntu-latest"] });
  const items: ActivityItem[] = [
    {
      id: 17,
      type: "job.routed",
      data: {},
      occurredAt: at(0.02),
      actor: null,
      machine: null,
      job: job(7, 0.02, {
        name: "test (macos)",
        starters: { startedBy: zach, rerunBy: null },
        runnerName: "GitHub Actions 15",
        status: "in_progress",
        startedAt: at(0.01),
        walk: {
          step: "github",
          skipped: [
            {
              key: "machine",
              reason: "machine_not_shared",
              notShared: [{ machine: mac.name, owner: "Atticus White" }],
            },
          ],
          notInOrder: [],
          ...relayInputs({ machine: ["macOS", "ARM64"], github: ["macos-latest"] }),
        },
      }),
    },
    {
      id: 16,
      type: "machine.sharing_changed",
      data: { machineName: mac.name, sharing: "anyone" },
      occurredAt: at(0.03),
      actor: { id: "u1", name: "Atticus White" },
      machine: mac,
      job: null,
    },
    {
      id: 15,
      type: "job.routed",
      data: {},
      occurredAt: at(0.02),
      actor: null,
      machine: null,
      job: job(7, 0.02, {
        name: "build",
        runner: { type: "machine", machineId: mac.id, name: mac.name },
        runnerName: `${mac.name}-0123456789ab`,
        status: "in_progress",
        startedAt: at(0.01),
        walk: {
          step: "machine",
          skipped: [
            {
              key: "github",
              reason: "minutes_limit",
              minutes: {
                account: "relayrunner",
                usedMinutes: 1640,
                quotaMinutes: 2000,
                percent: 80,
                burnRatePerHour: 38,
              },
            },
          ],
          notInOrder: [],
          ...relay,
        },
      }),
    },
    {
      id: 14,
      type: "minutes.overage",
      data: {
        account: "acme-labs",
        installationId: 2,
        cycleStart: new Date(Date.UTC(2026, 10, 1)).toISOString(),
        netAmount: 0.67,
      },
      occurredAt: at(3),
      actor: null,
      machine: null,
      job: null,
    },
    {
      id: 13,
      type: "job.routed",
      data: {},
      occurredAt: at(0.05),
      actor: null,
      machine: null,
      job: job(6, 0.05, {
        name: "test (macos)",
        runAttempt: 2,
        starters: { startedBy: atticus, rerunBy: zach },
        runnerName: "GitHub Actions 14",
        status: "in_progress",
        startedAt: at(0.04),
        walk: {
          step: "github",
          skipped: [{ key: "machine", reason: "machine_paused", paused: [mac.name] }],
          notInOrder: [],
          ...relayInputs({ machine: ["macOS", "ARM64"], github: ["macos-latest"] }),
        },
      }),
    },
    {
      id: 12,
      type: "machine.paused",
      data: { machineName: mac.name, via: "dashboard" },
      occurredAt: at(0.15),
      actor: { id: "u1", name: "Atticus White" },
      machine: mac,
      job: null,
    },
    {
      id: 103,
      type: "settings.job_size",
      data: {
        repository: "relayrunner/relayrunner-ci-tests",
        workflow: "RelayRunner dev",
        job: "test",
        size: 8,
        first: "machine",
        via: "agent",
        agent: "Claude",
      },
      occurredAt: at(4),
      actor: { id: "u1", name: "Atticus White" },
      machine: null,
      job: null,
    },
    {
      id: 102,
      type: "settings.runner_order",
      data: {
        steps: [{ key: "machine" }, { key: "github", limit: { percent: 80 } }, { key: "github" }],
        via: "agent",
        agent: "Claude",
      },
      occurredAt: at(6),
      actor: { id: "u1", name: "Atticus White" },
      machine: null,
      job: null,
    },
    {
      id: 101,
      type: "settings.retries",
      data: { enabled: true, runner: "other", max: 1, via: "dashboard" },
      occurredAt: at(12),
      actor: { id: "u2", name: "Zach Ross" },
      machine: null,
      job: null,
    },
    {
      id: 11,
      type: "machine.resumed",
      data: { machineName: mac.name, via: "cli" },
      occurredAt: at(20),
      actor: null,
      machine: mac,
      job: null,
    },
    {
      id: 10,
      type: "job.unroutable",
      data: {
        repository: "relayrunner/relayrunner-ci-tests",
        runId: 90,
        runAttempt: 1,
        workflow: "RelayRunner dev",
        job: "relay",
        reason: `No runner available: the only machine that fits, ${mac.name}, is paused.`,
        walk: {
          step: null,
          skipped: [
            { key: "machine", reason: "machine_paused", paused: [mac.name] },
            { key: "github", reason: "not_configured" },
          ],
          notInOrder: [],
          ...relayInputs({ machine: ["macOS", "ARM64"], github: [] }),
        },
      },
      occurredAt: at(0.1),
      actor: null,
      machine: null,
      job: null,
      jobsNotRun: ["test (macos)", "deploy"],
      starters: { startedBy: zach, rerunBy: null },
    },
    {
      id: 9,
      type: "job.routed",
      data: {},
      occurredAt: at(3),
      actor: null,
      machine: null,
      job: job(5, 3, {
        starters: { startedBy: { login: "dependabot[bot]", member: null }, rerunBy: null },
        runner: { type: "hosted", provider: "blacksmith", label: "blacksmith-2vcpu-ubuntu-2404" },
        runnerName: "blacksmith-2vcpu-ubuntu-2404-x7k2p",
        status: "completed",
        conclusion: "success",
        startedAt: at(2.9),
        completedAt: at(0.7),
        walk: {
          step: "blacksmith",
          skipped: [{ key: "machine", reason: "no_machine" }],
          notInOrder: [],
          ...relayInputs({
            machine: ["macOS", "ARM64"],
            github: ["ubuntu-latest"],
            blacksmith: ["blacksmith-2vcpu-ubuntu-2404"],
          }),
        },
      }),
    },
    {
      id: 8,
      type: "job.routed",
      data: {},
      occurredAt: at(9),
      actor: null,
      machine: null,
      job: job(4, 9, {
        runner: { type: "machine", machineId: "m1", name: mac.name },
        runnerName: "Atticus-s-MacBook-0123456789ab",
        status: "completed",
        conclusion: "success",
        startedAt: at(8.9),
        completedAt: at(7.4),
        walk: { step: "machine", skipped: [], notInOrder: ["github"], ...relay },
      }),
    },
    {
      id: 7,
      type: "job.routed",
      data: {},
      occurredAt: at(0.2),
      actor: null,
      machine: null,
      job: job(3, 0.2, {
        workflow: "RelayRunner machine test",
        name: "machine",
        runner: { type: "machine", machineId: "m1", name: mac.name },
        runnerName: "Atticus-s-MacBook-0123456789ab",
        status: "in_progress",
        startedAt: at(0.1),
        walk: { step: "machine", skipped: [], notInOrder: [], ...relay },
      }),
    },
    {
      id: 6,
      type: "machine.connected",
      data: { machineName: mac.name, runnerVersion: "2.330.0" },
      occurredAt: at(1),
      actor: null,
      machine: mac,
      job: null,
    },
    {
      id: 5,
      type: "machine.disconnected",
      data: { machineName: mac.name, reason: "timeout" },
      occurredAt: at(25),
      actor: null,
      machine: mac,
      job: null,
    },
    {
      id: 4,
      type: "job.routed",
      data: {},
      occurredAt: at(38),
      actor: null,
      machine: null,
      job: job(2, 38, {
        private: false,
        repository: "relayrunner/actions",
        runnerName: "GitHub Actions 7",
        status: "completed",
        conclusion: "success",
        startedAt: at(37.5),
        completedAt: at(36),
        walk: {
          step: "github",
          skipped: [{ key: "machine", reason: "public_repo" }],
          notInOrder: [],
          ...relay,
        },
      }),
    },
    {
      id: 3,
      type: "job.routed",
      data: {},
      occurredAt: at(180),
      actor: null,
      machine: null,
      // A run from before relays failed fast: GitHub skipped the job and never sent it anywhere.
      job: job(1, 180, {
        name: "deploy",
        runner: { type: "github", label: "" },
        status: "completed",
        conclusion: "skipped",
        completedAt: at(180),
      }),
    },
    {
      id: 14,
      type: "machine.revoked",
      data: { machineName: "zach-studio" },
      occurredAt: at(14.9),
      actor: { id: "u1", name: "Atticus White" },
      machine: { id: "m2", name: "zach-studio" },
      job: null,
    },
    {
      id: 15,
      type: "member.removed",
      data: { memberName: "Zach", left: false },
      occurredAt: at(15),
      actor: { id: "u1", name: "Atticus White" },
      machine: null,
      job: null,
    },
    {
      id: 16,
      type: "member.joined",
      data: { name: "Ada Lovelace", email: "ada@example.com", role: "admin" },
      occurredAt: at(20),
      actor: { id: "u2", name: "Ada Lovelace" },
      machine: null,
      job: null,
    },
    {
      id: 51,
      type: "check.completed",
      data: {
        check: "Lint",
        repository: "relayrunner/relayrunner-ci-tests",
        repositoryId: 1,
        pullRequest: null,
        headSha: "4f9c2e1a7b",
        conclusion: "failure",
        url: null,
      },
      occurredAt: at(1),
      actor: null,
      machine: null,
      job: null,
    },
    {
      id: 50,
      type: "check.completed",
      data: {
        check: "PR title",
        repository: "relayrunner/relayrunner-ci-tests",
        repositoryId: 1,
        pullRequest: 42,
        headSha: "abc123",
        conclusion: "success",
        url: "https://github.com/relayrunner/relayrunner-ci-tests/runs/1",
      },
      occurredAt: at(2),
      actor: null,
      machine: null,
      job: null,
    },
    {
      id: 2,
      type: "machine.enrolled",
      data: { machineName: mac.name, os: "macos", arch: "arm64" },
      occurredAt: at(60),
      actor: { id: "u1", name: "Atticus White" },
      machine: mac,
      job: null,
    },
  ];
  items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return {
    nextBefore: null,
    items: items.filter((item) => sampleMatches(item, query)),
  };
}

// The API's filters, applied to the sample entries.
function sampleMatches(item: ActivityItem, query: ActivityQuery) {
  if (query.filter && !item.type.startsWith(`${query.filter}.`)) return false;
  if (query.since && Date.parse(item.occurredAt) < query.since) return false;
  if (query.repository) {
    const repo = item.job?.repository ?? ("repository" in item.data ? item.data.repository : null);
    if (repo !== query.repository) return false;
  }
  if (query.machine) {
    const runner = item.job?.runner;
    const machine = item.machine?.id ?? (runner?.type === "machine" ? runner.machineId : null);
    if (machine !== query.machine) return false;
  }
  return !query.result || sampleResult(item) === query.result;
}

function sampleResult(item: ActivityItem): ActivityResult | null {
  if (item.type === "job.unroutable") return "failed";
  const conclusion = item.job
    ? item.job.conclusion
    : "conclusion" in item.data
      ? item.data.conclusion
      : undefined;
  if (conclusion === undefined) return null;
  if (conclusion === null) return "running";
  if (conclusion === "success") return "passed";
  if (conclusion === "failure" || conclusion === "timed_out") return "failed";
  return conclusion as ActivityResult;
}

export function sampleActivityOptions(): ActivityOptions {
  return {
    repositories: ["relayrunner/actions", "relayrunner/relayrunner-ci-tests"],
    machines: [{ id: "m1", name: "Atticuss-MacBook-Pro.local" }],
  };
}
