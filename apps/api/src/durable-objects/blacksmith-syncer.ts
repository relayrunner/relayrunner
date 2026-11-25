import { DurableObject } from "cloudflare:workers";
import {
  BLACKSMITH_PORT,
  type CliRequest,
  type CliResponse,
} from "@relayrunner/blacksmith-cli/protocol";
import type { Env } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { log } from "../log.ts";

// 1/16 vCPU, 256 MiB: the CLI only waits on Blacksmith's API.
const INSTANCE = "lite";
// How long the container's server gets to come up, and how long one health check may take.
const BOOT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;
// A usage read with every page of jobs takes well under this. One that doesn't fails like any other
// error, and the next hour tries again.
const RUN_TIMEOUT_MS = 5 * 60_000;
// How long stopping the container may hold up the answer.
const DESTROY_TIMEOUT_MS = 10_000;
// The caller stops waiting after this, so one stuck container can't hold its queue batch past the
// queue's 15-minute limit.
const CALL_TIMEOUT_MS = BOOT_TIMEOUT_MS + RUN_TIMEOUT_MS + DESTROY_TIMEOUT_MS + 30_000;

// One per workspace (named by its id). Runs Blacksmith's CLI in the Blacksmith container
// (packages/blacksmith-cli) for the workspace's Blacksmith connection: a check of the token, or the
// hourly usage read. Runs go one at a time, so a test of the token never stops the container under
// an hourly sync. The container stops after each run; the token only travels in the request.
export class BlacksmithSyncer extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();

  run(request: CliRequest): Promise<CliResponse> {
    const next = this.queue.then(() => this.runNow(request));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runNow(request: CliRequest): Promise<CliResponse> {
    const startedAt = Date.now();
    const container = this.ctx.container;
    if (!container) return { ok: false, reason: "error", message: "no container is configured" };
    try {
      if (!container.running)
        container.start({
          image: container.images.blacksmith,
          instance: INSTANCE,
          enableInternet: true,
        });
      const port = container.getTcpPort(BLACKSMITH_PORT);
      await waitForHealth(port);
      const body = await withDeadline(RUN_TIMEOUT_MS, "the CLI didn't answer", async (signal) => {
        const response = await port.fetch("http://blacksmith/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal,
        });
        return (await response.json()) as CliResponse;
      });
      logRun(request, startedAt, body.ok ? {} : { reason: body.reason });
      return body;
    } catch (error) {
      const message = errorMessage(error);
      logRun(request, startedAt, { reason: "error", error: message });
      return { ok: false, reason: "error", message: `the Blacksmith container failed: ${message}` };
    } finally {
      if (container.running)
        await withDeadline(DESTROY_TIMEOUT_MS, "the container didn't stop", () =>
          container.destroy(),
        ).catch(() => undefined);
    }
  }
}

async function waitForHealth(port: Fetcher) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    try {
      const healthy = await withDeadline(HEALTH_TIMEOUT_MS, "no answer", async (signal) => {
        return (await port.fetch("http://blacksmith/health", { signal })).ok;
      });
      if (healthy) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("the container didn't start");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * `work`'s result, or an Error with `message` once `ms` pass, aborting `work`'s signal. The timer is
 * cleared either way: a timer left pending (as AbortSignal.timeout leaves one) keeps the call open
 * until it fires.
 */
async function withDeadline<T>(
  ms: number,
  message: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Never the token: only what ran, for whom, and how it went.
function logRun(request: CliRequest, startedAt: number, fields: Record<string, unknown>) {
  (fields.reason ? log.warn : log.info)("provider.blacksmith_cli_run", "blacksmith cli run", {
    kind: request.kind,
    organization: request.organization,
    durationMs: Date.now() - startedAt,
    ...fields,
  });
}

/** Runs the Blacksmith CLI for a workspace; undefined where the binding isn't set up (tests). */
export function blacksmithSyncer(env: Env, workspaceId: string) {
  const namespace = env.BLACKSMITH_SYNCER;
  if (!namespace) return undefined;
  return (request: CliRequest): Promise<CliResponse> =>
    withDeadline(CALL_TIMEOUT_MS, "the Blacksmith container didn't answer", () =>
      namespace.get(namespace.idFromName(workspaceId)).run(request),
    ).catch((error: unknown): CliResponse => ({
      ok: false,
      reason: "error",
      message: errorMessage(error),
    }));
}
