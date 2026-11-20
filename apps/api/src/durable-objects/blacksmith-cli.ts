import { DurableObject } from "cloudflare:workers";
import {
  BLACKSMITH_PORT,
  type CliRequest,
  type CliResponse,
} from "@relayrunner/blacksmith-cli/protocol";
import type { Env } from "../env.ts";
import { errorMessage } from "../errors.ts";

// 1/16 vCPU, 256 MiB: the CLI only waits on Blacksmith's API.
const INSTANCE = "lite";
// How long the container's server gets to come up.
const BOOT_TIMEOUT_MS = 60_000;
// A usage read with every page of jobs takes well under this. One that doesn't fails like any other
// error, and the next hour tries again.
const RUN_TIMEOUT_MS = 10 * 60_000;

// One per workspace (named by its id). Runs Blacksmith's CLI in the Blacksmith container
// (packages/blacksmith-cli) for the workspace's Blacksmith connection: a check of the token, or the
// hourly usage read. Runs go one at a time, so a test of the token never stops the container under
// an hourly sync. The container stops after each run; the token only travels in the request.
export class BlacksmithCli extends DurableObject<Env> {
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
      const response = await port.fetch("http://blacksmith/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      });
      const body = (await response.json()) as CliResponse;
      log(request, startedAt, body.ok ? {} : { reason: body.reason });
      return body;
    } catch (error) {
      const message = errorMessage(error);
      log(request, startedAt, { reason: "error", error: message });
      return { ok: false, reason: "error", message: `the Blacksmith container failed: ${message}` };
    } finally {
      if (container.running) await container.destroy().catch(() => undefined);
    }
  }
}

async function waitForHealth(port: Fetcher) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    try {
      if ((await port.fetch("http://blacksmith/health")).ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("the container didn't start");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Never the token: only what ran, for whom, and how it went.
function log(request: CliRequest, startedAt: number, fields: Record<string, unknown>) {
  (fields.reason ? console.warn : console.log)(
    JSON.stringify({
      msg: "blacksmith cli run",
      kind: request.kind,
      organization: request.organization,
      durationMs: Date.now() - startedAt,
      ...fields,
    }),
  );
}

/** Runs the Blacksmith CLI for a workspace; undefined where the binding isn't set up (tests). */
export function blacksmithCli(env: Env, workspaceId: string) {
  const namespace = env.BLACKSMITH_CLI;
  if (!namespace) return undefined;
  return (request: CliRequest) => namespace.get(namespace.idFromName(workspaceId)).run(request);
}
