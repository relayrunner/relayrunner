// Namespace's UsageService, over the Connect protocol on the regional Compute endpoint, with a
// revokable token from `nsc token create`. Schema: buf.build/namespace/cloud
// (namespace.cloud.compute.v1beta, usage.proto). Namespace counts usage in unit minutes, not
// dollars:
// - GetUsage gives unit and wall minutes per day.
// - GenerateReport (a server stream) gives each instance with the GitHub job it served, so a job's
//   billable time is how long its instance ran.
import {
  type AdapterContext,
  type BillingAdapter,
  type DailyUsage,
  date,
  type JobUsage,
  num,
  ProviderApiError,
  ProviderAuthError,
  connectUnary,
  responseError,
  secondsBetween,
  text,
  utcDay,
  type UsageWindow,
} from "./types.ts";

const SERVICE = "namespace.cloud.compute.v1beta.UsageService";
const REGIONS = new Set(["us", "eu"]);

function endpoint(ctx: AdapterContext, method: string) {
  const region = REGIONS.has(ctx.options.region ?? "") ? ctx.options.region : "us";
  return `https://${region}.compute.namespaceapis.com/${SERVICE}/${method}`;
}

const protoDate = (at: Date) => ({
  year: at.getUTCFullYear(),
  month: at.getUTCMonth() + 1,
  day: at.getUTCDate(),
});

interface UsageRecord {
  year?: number;
  month?: number;
  day?: number;
  total?: { instanceMinutes?: { unit?: string | number; wall?: string | number } };
}

const getUsage = (ctx: AdapterContext, start: Date, end: Date) =>
  connectUnary<{ perDay?: UsageRecord[] }>(ctx, endpoint(ctx, "GetUsage"), {
    periodStart: protoDate(start),
    periodEnd: protoDate(end),
  });

export function namespaceDays(records: UsageRecord[]): DailyUsage[] {
  return records.flatMap((record) => {
    if (!record.year || !record.month || !record.day) return [];
    const day = new Date(Date.UTC(record.year, record.month - 1, record.day));
    const minutes = record.total?.instanceMinutes;
    return [
      { day, unit: "unit_minutes", quantity: num(minutes?.unit) ?? 0, costUsd: null },
      { day, unit: "wall_minutes", quantity: num(minutes?.wall) ?? 0, costUsd: null },
    ];
  });
}

interface ReportEntry {
  startedAt?: string;
  destroyedAt?: string;
  githubJob?: {
    jobId?: string | number;
    runId?: string | number;
    jobName?: string;
    repository?: string;
    profile?: string;
    jobCreatedAt?: string;
    jobStartedAt?: string;
    jobCompletedAt?: string;
  };
}

export function namespaceJob(entry: ReportEntry): JobUsage | null {
  const job = entry.githubJob;
  const jobId = num(job?.jobId);
  if (!job || !jobId) return null;
  const instanceStarted = date(entry.startedAt);
  const instanceEnded = date(entry.destroyedAt);
  return {
    jobId: String(job.jobId),
    runId: job.runId ? String(job.runId) : null,
    repository: text(job.repository),
    jobName: text(job.jobName),
    runnerLabel: text(job.profile),
    startedAt: date(job.jobStartedAt) ?? instanceStarted,
    finishedAt: date(job.jobCompletedAt) ?? instanceEnded,
    billableSeconds: secondsBetween(instanceStarted, instanceEnded),
    queueSeconds: secondsBetween(date(job.jobCreatedAt), date(job.jobStartedAt)),
    costUsd: null,
  };
}

/**
 * Call a Connect server-streaming method with JSON: the request and each response message are
 * enveloped (1 flag byte, 4-byte big-endian length, then JSON). The last envelope has flag 0x02
 * and carries `{ error? }`.
 */
export async function connectStream<T>(
  ctx: AdapterContext,
  url: string,
  request: unknown,
): Promise<T[]> {
  const response = await ctx.fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.token}`,
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
    },
    body: envelope(0, new TextEncoder().encode(JSON.stringify(request))),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw await responseError(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const messages: T[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 5 <= bytes.byteLength) {
    const flags = bytes[offset]!;
    const length = view.getUint32(offset + 1);
    const json = new TextDecoder().decode(bytes.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
    const message = JSON.parse(json) as unknown;
    if (flags & 0x02) {
      const error = (message as { error?: { code?: string; message?: string } }).error;
      if (!error) return messages;
      const text = `${error.code ?? "unknown"}: ${error.message ?? ""}`;
      throw error.code === "unauthenticated" || error.code === "permission_denied"
        ? new ProviderAuthError(text)
        : new ProviderApiError(text);
    }
    messages.push(message as T);
  }
  throw new ProviderApiError("Namespace's stream ended without an end message");
}

export function envelope(flags: number, data: Uint8Array) {
  const out = new Uint8Array(5 + data.byteLength);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, data.byteLength);
  out.set(data, 5);
  return out;
}

export const namespace: BillingAdapter = {
  async verify(ctx) {
    const today = utcDay(new Date());
    await getUsage(ctx, today, today);
    // The token doesn't say which workspace it belongs to.
    return { accountName: null };
  },

  async usage(ctx, window: UsageWindow) {
    const [{ perDay }, reports] = await Promise.all([
      getUsage(ctx, window.start, window.end),
      connectStream<{ entries?: ReportEntry[] }>(ctx, endpoint(ctx, "GenerateReport"), {
        startTime: window.start.toISOString(),
        endTime: window.end.toISOString(),
      }),
    ]);
    // Instances that served no GitHub job (Buildkite, builders) have no githubJob and drop out.
    const jobs = reports.flatMap((report) =>
      (report.entries ?? []).flatMap((entry) => namespaceJob(entry) ?? []),
    );
    return { jobs, days: namespaceDays(perDay ?? []) };
  },
};
