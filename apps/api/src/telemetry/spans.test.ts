import type { WorkflowJob, WorkflowRun } from "@relayrunner/github-webhooks";
import { describe, expect, test } from "vitest";
import { jobSpans, otlpRequest, runIds, runSpan } from "./spans.ts";

const repository = { id: 7, fullName: "acme/app" };

const job: WorkflowJob = {
  id: 501,
  runId: 90,
  runAttempt: 2,
  name: "build",
  workflowName: "CI",
  status: "completed",
  conclusion: "failure",
  labels: ["ubuntu-latest"],
  headBranch: "main",
  headSha: "abc123",
  runnerName: "GitHub Actions 12",
  createdAt: "2026-11-14T10:00:00Z",
  startedAt: "2026-11-14T10:00:20Z",
  completedAt: "2026-11-14T10:02:00Z",
  steps: [
    {
      name: "Set up job",
      number: 1,
      conclusion: "success",
      startedAt: "2026-11-14T10:00:20Z",
      completedAt: "2026-11-14T10:00:22Z",
    },
    {
      name: "Run tests",
      number: 2,
      conclusion: "failure",
      startedAt: "2026-11-14T10:00:22Z",
      completedAt: "2026-11-14T10:01:59Z",
    },
    { name: "Deploy", number: 3, conclusion: "skipped", startedAt: null, completedAt: null },
  ],
};

const run: WorkflowRun = {
  id: 90,
  runAttempt: 2,
  workflowName: "CI",
  workflowId: null,
  workflowPath: null,
  defaultBranch: null,
  displayTitle: "Fix the thing",
  event: "pull_request",
  actorLogin: "octo",
  startedBy: { id: 1, login: "octo" },
  triggeredBy: { id: 2, login: "cat" },
  headBranch: "main",
  headSha: "abc123",
  pullRequestNumber: 12,
  status: "completed",
  conclusion: "success",
  htmlUrl: "https://github.com/acme/app/actions/runs/90",
  runStartedAt: "2026-11-14T09:59:58Z",
  updatedAt: "2026-11-14T10:03:00Z",
};

describe("spans", () => {
  test("a job is a child of its run, with its wait and the steps that ran", async () => {
    const ids = await runIds(7, 90, 2);
    expect(ids.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.spanId).toMatch(/^[0-9a-f]{16}$/);
    const spans = await jobSpans({
      repository,
      job,
      ranOn: { provider: "github", runner: "Linux 2-core" },
      usage: null,
    });
    expect(spans.map((s) => s.name)).toEqual([
      "build",
      "Waiting for a runner",
      "Set up job",
      "Run tests",
    ]);
    const [jobSpan, wait, , tests] = spans;
    expect(spans.every((s) => s.traceId === ids.traceId)).toBe(true);
    expect(jobSpan!.parentSpanId).toBe(ids.spanId);
    expect(wait!.parentSpanId).toBe(jobSpan!.spanId);
    expect(tests!.parentSpanId).toBe(jobSpan!.spanId);
    expect(jobSpan!.start).toBe(Date.parse("2026-11-14T10:00:00Z"));
    expect(jobSpan!.attributes).toMatchObject({
      "cicd.pipeline.task.name": "build",
      "cicd.pipeline.task.run.id": "501",
      "cicd.pipeline.task.run.url.full": "https://github.com/acme/app/actions/runs/90/job/501",
      "cicd.pipeline.task.run.result": "failure",
      "error.type": "failure",
      "relayrunner.provider": "github",
      "relayrunner.runner": "Linux 2-core",
      "relayrunner.queue.wait_ms": 20_000,
      "relayrunner.billed_minutes": 2,
    });
    expect(jobSpan!.error).toBe("failure");
    expect(tests!.error).toBe("failure");
    // Same ids every time, so a redelivery doesn't make a second trace.
    const again = await jobSpans({ repository, job, ranOn: null, usage: null });
    expect(again.map((s) => s.spanId)).toEqual(spans.map((s) => s.spanId));
  });

  test("a job no runner took has no wait and no billed minutes", async () => {
    const [span, ...rest] = await jobSpans({
      repository,
      job: { ...job, startedAt: null, conclusion: "cancelled", steps: [] },
      ranOn: null,
      usage: null,
    });
    expect(rest).toEqual([]);
    expect(span!.attributes["cicd.pipeline.task.run.result"]).toBe("cancellation");
    expect(span!.attributes["relayrunner.billed_minutes"]).toBeNull();
    expect(span!.error).toBeUndefined();
  });

  test("the run is the root, with its route and whether it was a retry", async () => {
    const span = await runSpan({
      repository,
      run,
      route: { provider: "depot", skipped: ["machine: all busy"] },
      retry: true,
    });
    expect(span).toMatchObject({
      ...(await runIds(7, 90, 2)),
      name: "RUN CI",
      kind: "server",
      attributes: {
        "cicd.pipeline.name": "CI",
        "cicd.pipeline.run.id": "90",
        "cicd.pipeline.result": "success",
        "vcs.change.id": "12",
        "relayrunner.run.actor": "cat",
        "relayrunner.routed": true,
        "relayrunner.route.provider": "depot",
        "relayrunner.route.skipped": ["machine: all busy"],
        "relayrunner.retry": true,
      },
    });
    expect(span!.parentSpanId).toBeUndefined();
  });

  test("encode as OTLP JSON", async () => {
    const [span] = await jobSpans({ repository, job, ranOn: null, usage: null });
    const body = otlpRequest([{ resource: { "service.name": "ci" }, spans: [span!] }]);
    const encoded = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(body.resourceSpans[0]!.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "ci" } },
    ]);
    expect(encoded).toMatchObject({
      kind: 1,
      startTimeUnixNano: `${Date.parse("2026-11-14T10:00:00Z")}000000`,
      status: { code: 2, message: "failure" },
    });
    expect(encoded.attributes).toContainEqual({
      key: "relayrunner.labels",
      value: { arrayValue: { values: [{ stringValue: "ubuntu-latest" }] } },
    });
    expect(encoded.attributes).toContainEqual({
      key: "relayrunner.queue.wait_ms",
      value: { intValue: "20000" },
    });
    // Unset attributes are left out rather than sent empty.
    expect(encoded.attributes.some((a) => a.key === "relayrunner.provider")).toBe(false);
  });
});
