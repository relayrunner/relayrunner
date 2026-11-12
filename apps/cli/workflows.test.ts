import { describe, expect, test } from "vitest";
import { analyzeWorkflows, isSetUp, RELAY_REF, routeJobs, type WorkflowJob } from "./workflows.ts";

const file = ".github/workflows/ci.yml";

function judge(source: string, hostOs: "macos" | "linux" = "macos", vm = false) {
  const { jobs, errors } = analyzeWorkflows([{ file, source }], { hostOs, vm });
  expect(errors).toEqual([]);
  return jobs;
}

function one(source: string, hostOs?: "macos" | "linux"): WorkflowJob {
  const jobs = judge(source, hostOs);
  expect(jobs).toHaveLength(1);
  return jobs[0]!;
}

const job = (body: string, on = "push") => `on: ${on}\njobs:\n  test:\n${body}`;

describe("analyzeWorkflows", () => {
  test("a plain GitHub-hosted label is ready", () => {
    expect(
      one(job("    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n")),
    ).toMatchObject({
      verdict: "ready",
      provider: "github",
      label: "ubuntu-latest",
      machine: "self-hosted",
      warnings: [],
    });
  });

  test("a macOS label only routes to macOS machines", () => {
    expect(one(job("    runs-on: macos-15\n"))).toMatchObject({
      verdict: "ready",
      label: "macos-15",
      machine: "macOS",
    });
  });

  test("a Blacksmith label goes to the blacksmith input", () => {
    expect(
      one(
        job(
          "    runs-on: blacksmith-2vcpu-ubuntu-2404\n    steps:\n      - uses: useblacksmith/checkout@v1\n",
        ),
      ),
    ).toMatchObject({
      verdict: "ready",
      provider: "blacksmith",
      label: "blacksmith-2vcpu-ubuntu-2404",
      warnings: ["uses useblacksmith/checkout, which is made for Blacksmith runners"],
    });
  });

  test("another hosted provider's label goes to its own input", () => {
    expect(one(job("    runs-on: depot-ubuntu-24.04\n"))).toMatchObject({
      verdict: "ready",
      provider: "depot",
      label: "depot-ubuntu-24.04",
      machine: "self-hosted",
    });
    expect(one(job("    runs-on: depot-macos-latest\n"))).toMatchObject({
      provider: "depot",
      machine: "macOS",
    });
  });

  test.each([
    [
      "a matrix",
      "    strategy:\n      matrix:\n        node: [20, 22]\n    runs-on: ubuntu-latest\n",
      "matrix",
    ],
    [
      "an expression runs-on",
      "    runs-on: ${{ github.event_name == 'push' && 'ubuntu-latest' || 'ubuntu-24.04' }}\n",
      "expression",
    ],
    ["a list of labels", "    runs-on: [self-hosted, linux]\n", "list of labels"],
    ["a runner group", "    runs-on:\n      group: big\n", "runner group"],
    ["a reusable workflow call", "    uses: ./.github/workflows/shared.yml\n", "reusable workflow"],
    [
      "an environment",
      "    runs-on: ubuntu-latest\n    environment: production\n",
      "deploy job (environment)",
    ],
    [
      "id-token: write",
      "    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n",
      "deploy job (id-token: write)",
    ],
    [
      "a secret",
      "    runs-on: ubuntu-latest\n    steps:\n      - run: deploy\n        env:\n          TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n",
      "secrets.DEPLOY_TOKEN",
    ],
    ["Windows", "    runs-on: windows-latest\n", "Windows"],
    ["the relayrunner label", "    runs-on: relayrunner\n", "already runs on RelayRunner"],
    ["a self-hosted label", "    runs-on: self-hosted\n", "self-hosted"],
    [
      "an unknown label",
      "    runs-on: my-big-runner\n",
      "isn't a GitHub-hosted or hosted provider label",
    ],
    ["no runs-on", "    steps: []\n", "no runs-on"],
  ])("skips %s", (_, body, reason) => {
    const result = one(job(body));
    expect(result.verdict).toBe("skipped");
    expect(result.reason).toContain(reason);
  });

  test("GITHUB_TOKEN alone isn't a deploy secret", () => {
    expect(
      one(
        job(
          "    runs-on: ubuntu-latest\n    steps:\n      - run: gh pr list\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
        ),
      ).verdict,
    ).toBe("ready");
  });

  test("workflow-level id-token permission counts when the job sets none", () => {
    const result = one(
      `on: push\npermissions:\n  id-token: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n`,
    );
    expect(result.reason).toContain("id-token");
  });

  test("a workflow that only runs on workflow_call is skipped", () => {
    expect(one(job("    runs-on: ubuntu-latest\n", "workflow_call")).reason).toContain(
      "reusable workflow",
    );
  });

  test("warns about services, containers and Linux packages on a Mac", () => {
    const source = job(
      "    runs-on: ubuntu-latest\n    container: node:22\n    services:\n      db:\n        image: postgres\n    steps:\n      - run: sudo apt-get install -y jq\n",
    );
    expect(one(source, "macos").warnings).toEqual([
      "uses services, which need Docker on the machine",
      "runs in a container, which needs Docker on the machine",
      "installs Linux packages (apt-get, yum or apk), which macOS doesn't have",
    ]);
    expect(one(source, "linux").warnings).toHaveLength(2);
    // A Mac that runs Linux jobs in a VM has Docker and Linux packages.
    expect(judge(source, "macos", true)[0]!.warnings).toEqual([]);
  });

  test("a job behind a relay is routed, and the relay itself isn't listed", () => {
    const jobs = judge(`on: push
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1.0.0-beta.2
    with:
      machine: self-hosted
      github: ubuntu-latest
  test:
    needs: relay-test
    runs-on: \${{ needs.relay-test.outputs.runner }}
  lint:
    runs-on: ubuntu-latest
`);
    expect(jobs.map((j) => [j.job, j.verdict])).toEqual([
      ["test", "routed"],
      ["lint", "ready"],
    ]);
    expect(isSetUp(jobs)).toBe(true);
  });

  test("reports a file it can't parse and keeps going", () => {
    const { jobs, errors } = analyzeWorkflows([
      { file: "bad.yml", source: "jobs: [\n" },
      { file, source: job("    runs-on: ubuntu-latest\n") },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe("bad.yml");
    expect(jobs).toHaveLength(1);
  });
});

describe("routeJobs", () => {
  const source = `name: CI

# Runs on every push.
on:
  push:
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest # keep this comment
    steps:
      - uses: actions/checkout@v4
      - run: npm test

  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint

  # Builds after both checks pass.
  build:
    needs: [test, lint]
    runs-on: ubuntu-24.04
    steps:
      - run: npm run build
`;

  test("adds a relay in front of each job and keeps the rest of the file", () => {
    const jobs = judge(source);
    expect(routeJobs(source, [jobs[0]!, jobs[2]!])).toBe(`name: CI

# Runs on every push.
on:
  push:
  workflow_dispatch:

jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@${RELAY_REF}
    with:
      machine: self-hosted
      github: ubuntu-latest

  test:
    needs: relay-test
    runs-on: \${{ needs.relay-test.outputs.runner }} # keep this comment
    steps:
      - uses: actions/checkout@v4
      - run: npm test

  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint

  # Builds after both checks pass.
  relay-build:
    uses: relayrunner/actions/.github/workflows/relay.yml@${RELAY_REF}
    with:
      machine: self-hosted
      github: ubuntu-24.04

  build:
    needs: [test, lint, relay-build]
    runs-on: \${{ needs.relay-build.outputs.runner }}
    steps:
      - run: npm run build
`);
  });

  test("the result reads back as routed", () => {
    const routed = routeJobs(source, judge(source));
    expect(judge(routed).every((j) => j.verdict === "routed")).toBe(true);
  });

  test("a single needs becomes a list, and a taken relay id gets a suffix", () => {
    const input = `on: push
jobs:
  relay-test:
    runs-on: ubuntu-latest
  test:
    needs: build
    runs-on: blacksmith-4vcpu-ubuntu-2404
  build:
    runs-on: ubuntu-latest
`;
    const test = judge(input).find((j) => j.job === "test")!;
    const out = routeJobs(input, [test]);
    expect(out).toContain("  relay-test-2:\n");
    expect(out).toContain("      blacksmith: blacksmith-4vcpu-ubuntu-2404\n");
    expect(out).toContain("    needs: [build, relay-test-2]\n");
  });

  test("refuses a job that isn't ready", () => {
    const skipped = one(job("    runs-on: windows-latest\n"));
    expect(() => routeJobs(job("    runs-on: windows-latest\n"), [skipped])).toThrow("isn't ready");
  });

  test("leaves an untouched file byte for byte", () => {
    const flow =
      "on: [push, pull_request]\njobs:\n  a:\n    runs-on: ubuntu-latest\n  b:\n    runs-on: ubuntu-latest\n";
    const a = judge(flow).find((j) => j.job === "a")!;
    expect(routeJobs(flow, [a])).toContain("on: [push, pull_request]\n");
  });
});
