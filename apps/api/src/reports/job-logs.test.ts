import { afterEach, describe, expect, test, vi } from "vitest";
import { jobStepLogs, logText, uploadJobLogs } from "./job-logs.ts";

afterEach(() => vi.unstubAllGlobals());

describe("jobStepLogs", () => {
  const steps = [
    { id: "a", name: "Lint" },
    { id: "b", name: "PR title" },
  ];

  test("gives each step its result and marks the ones that didn't run", () => {
    expect(jobStepLogs(steps, [{ ok: false, lines: ["oxlint: failed"] }])).toEqual([
      { id: "a", number: 1, name: "Lint", ok: false, lines: ["oxlint: failed"] },
      { id: "b", number: 2, name: "PR title", ok: null, lines: [] },
    ]);
  });

  test("puts the reason on the first step when no step ran", () => {
    expect(jobStepLogs(steps, [], "Can't run this job.")[0]).toMatchObject({
      ok: false,
      lines: ["##[error]Can't run this job."],
    });
  });

  test("leaves out a step with no id", () => {
    expect(jobStepLogs([{ name: "Lint" }], [{ ok: true, lines: [] }])).toEqual([]);
  });
});

test("logText stamps every line", () => {
  expect(logText(["one", "two\nthree"], new Date("2026-11-12T01:02:03.004Z"))).toBe(
    "2026-11-12T01:02:03.0040000Z one\n2026-11-12T01:02:03.0040000Z two\n2026-11-12T01:02:03.0040000Z three\n",
  );
});

describe("uploadJobLogs", () => {
  const target = {
    resultsUrl: "https://results.example/base",
    token: "system-token",
    planId: "plan",
    jobId: "job",
  };
  const times = { startedAt: new Date(0), completedAt: new Date(1000) };

  function stubFetch(respond: (url: string) => Response = () => Response.json({ ok: true })) {
    const calls: { url: string; method?: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({
        url,
        method: init.method,
        headers: new Headers(init.headers),
        body: String(init.body ?? ""),
      });
      if (url.includes("SignedBlobURL"))
        return Response.json({
          logs_url: `https://blob.example/${calls.length}`,
          blob_storage_type: "BLOB_STORAGE_TYPE_AZURE",
        });
      return respond(url);
    });
    return calls;
  }

  test("sends the steps, then a log per step and the job's log", async () => {
    const calls = stubFetch();
    await uploadJobLogs(
      target,
      [
        { id: "a", number: 1, name: "Lint", ok: false, lines: ["bad"] },
        { id: "b", number: 2, name: "PR title", ok: null, lines: [] },
      ],
      times,
    );

    const [update] = calls;
    expect(update.url).toBe(
      "https://results.example/base/twirp/github.actions.results.api.v1.WorkflowStepUpdateService/WorkflowStepsUpdate",
    );
    expect(update.headers.get("authorization")).toBe("Bearer system-token");
    expect(JSON.parse(update.body)).toMatchObject({
      workflow_run_backend_id: "plan",
      workflow_job_run_backend_id: "job",
      steps: [
        { external_id: "a", number: 1, name: "Lint", status: 6, conclusion: 3 },
        { external_id: "b", number: 2, status: 6, conclusion: 7 },
      ],
    });

    const names = calls.map((call) => call.url.split("/").pop());
    expect(names.filter((name) => name === "GetStepLogsSignedBlobURL")).toHaveLength(1);
    expect(names.filter((name) => name === "GetJobLogsSignedBlobURL")).toHaveLength(1);
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0].headers.get("x-ms-blob-type")).toBe("BlockBlob");
    // The signed URL carries its own access, so the job's token never goes to blob storage.
    expect(puts.every((put) => !put.headers.has("authorization"))).toBe(true);
    const metadata = calls.find((call) => call.url.endsWith("CreateStepLogsMetadata"));
    expect(JSON.parse(metadata!.body)).toMatchObject({ step_backend_id: "a", line_count: 1 });
  });

  test("throws when GitHub turns a request down", async () => {
    stubFetch(() => new Response("no", { status: 403 }));
    await expect(
      uploadJobLogs(target, [{ id: "a", number: 1, name: "Lint", ok: true, lines: ["x"] }], times),
    ).rejects.toThrow("WorkflowStepsUpdate failed with status 403");
  });
});
