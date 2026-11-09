import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import type { DisconnectReason } from "@relayrunner/activity";
import { recordMachineEvent } from "../activity.ts";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { encodeMessage, PROTOCOL_VERSION, type JobMessage } from "@relayrunner/machine-protocol";
import {
  appJwt,
  generateJitConfig,
  importAppPrivateKey,
  installationToken,
} from "../github-app.ts";
import { installationRunnerScope } from "../installations.ts";
import { deviceColumns, pausedByName } from "../machines.ts";
import { machineRunnerName, routeLabel, type Route } from "../routing.ts";
import {
  CLOSE,
  handleFrame,
  HEARTBEAT_TIMEOUT_MS,
  isStale,
  MACHINE_ID_HEADER,
  newSession,
  OFFLINE,
  statusOf,
  type MachineStatus,
  type SessionState,
} from "./machine-session.ts";

export type RunResult = "sent" | "already_sent" | "offline";

// What MachineLink keeps for a route it handed to the machine, until the machine says the job is
// over. Its presence stops a redelivered webhook from minting a second runner.
interface SentRoute {
  workspaceId: string;
  // Unset while the JIT config is being minted.
  sentAt?: number;
}

const SENT_KEY = "sent:";

// One per enrolled machine, addressed by machine id. Holds the machine's `relayrunner connect`
// WebSocket, so a live socket that has said hello means the machine is online. Uses the
// hibernation API: each socket's SessionState lives in its attachment, not in memory.
export class MachineLink extends DurableObject<Env> {
  // Called by GET /api/machines/connect once the machine token checks out.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket.", { status: 426 });
    const machineId = request.headers.get(MACHINE_ID_HEADER);
    if (!machineId) return new Response("Missing machine id.", { status: 400 });

    // One socket per machine: a newer connection wins, so a restarted CLI never waits for the
    // old socket to time out.
    for (const old of this.ctx.getWebSockets()) close(old, CLOSE.replaced, "replaced");

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    server.serializeAttachment(newSession(machineId, now));
    await this.ctx.storage.setAlarm(now + HEARTBEAT_TIMEOUT_MS);
    await this.touch(machineId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, frame: string | ArrayBuffer) {
    const session = attachment(ws);
    if (!session) return close(ws, CLOSE.policy, "unknown socket");
    const outcome = handleFrame(session, frame, Date.now());
    ws.serializeAttachment(outcome.state);
    // The first hello is when the machine comes online. A paused machine hears so right away.
    if (!session.hello && outcome.state.hello) {
      const db = createDb(this.env.DB);
      await recordMachineEvent(db, session.machineId, {
        type: "machine.connected",
        data: { runnerVersion: outcome.state.hello.runnerVersion ?? null },
      });
      const device = outcome.state.hello.device;
      if (device)
        await db
          .update(schema.machine)
          .set(deviceColumns(device, new Date()))
          .where(eq(schema.machine.id, session.machineId));
      const [machine] = await db
        .select()
        .from(schema.machine)
        .where(eq(schema.machine.id, session.machineId))
        .limit(1);
      if (machine?.pausedAt) ws.send(pausedFrame(true, await pausedByName(db, machine)));
    }
    if ("job" in outcome && outcome.job) await this.onJob(session.machineId, outcome.job);
    if ("reply" in outcome) {
      ws.send(outcome.reply);
      close(ws, outcome.close.code, outcome.close.reason);
      await this.touch(session.machineId);
      await this.disconnected(session, "error");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Finish the closing handshake; the machine started it.
    close(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
    const session = attachment(ws);
    if (!session) return;
    await this.touch(session.machineId);
    // A close this side started (timeout, revoke, replaced, protocol error) was logged when it
    // closed, or deliberately not logged (replaced), so only the machine's own close counts here.
    if (!OWN_CLOSE_CODES.has(code)) await this.disconnected(session, "closed");
  }

  async webSocketError(ws: WebSocket) {
    const session = attachment(ws);
    if (session) await this.touch(session.machineId);
  }

  // Closes sockets that have gone quiet, and checks again while any remain.
  async alarm() {
    const now = Date.now();
    let earliest: number | undefined;
    for (const ws of this.ctx.getWebSockets()) {
      const session = attachment(ws);
      if (!session || isStale(session, now)) {
        close(ws, CLOSE.timeout, "heartbeat timeout");
        if (session) {
          await this.touch(session.machineId);
          await this.disconnected(session, "timeout");
        }
        continue;
      }
      earliest = Math.min(earliest ?? Infinity, session.lastHeardAt);
    }
    if (earliest !== undefined) await this.ctx.storage.setAlarm(earliest + HEARTBEAT_TIMEOUT_MS);
  }

  /** Online (said hello, heard from within the heartbeat timeout), idle or busy. */
  async status(): Promise<MachineStatus> {
    const ws = this.onlineSocket();
    return ws ? statusOf(attachment(ws), Date.now()) : OFFLINE;
  }

  /**
   * Hands a claimed route's job to the machine: mints a one-job runner on the route's label (in
   * the org, or on the repo for a personal account), named after the machine, and sends it in a
   * `run` message. Safe to call again for the same route (a redelivered webhook): only the first
   * call mints. "offline" means the machine has no
   * live socket, and the job stays queued (offline recovery is #71).
   */
  async run(work: { route: Route; workspaceId: string }): Promise<RunResult> {
    const { route, workspaceId } = work;
    const key = SENT_KEY + route.id;
    if (await this.ctx.storage.get(key)) return "already_sent";
    const socket = this.onlineSocket();
    if (!socket) return "offline";
    await this.ctx.storage.put<SentRoute>(key, { workspaceId });

    let jit;
    try {
      const appKey = await importAppPrivateKey(await this.env.GITHUB_APP_PRIVATE_KEY.get());
      const token = await installationToken(
        await appJwt(this.env.GITHUB_APP_ID, appKey),
        route.installationId,
      );
      const scope = await installationRunnerScope(
        createDb(this.env.DB),
        route.installationId,
        route.repo,
      );
      jit = await generateJitConfig(token, scope, {
        name: machineRunnerName(route.machineName, route.id),
        labels: [routeLabel(route.id)],
      });
    } catch (error) {
      // Let a retry of the webhook try again.
      await this.ctx.storage.delete(key);
      throw error;
    }
    // The socket may have closed while minting; the runner then expires unused.
    const live = this.onlineSocket() ?? socket;
    live.send(
      encodeMessage({
        v: PROTOCOL_VERSION,
        type: "run",
        routeId: route.id,
        jitConfig: jit.encodedJitConfig,
      }),
    );
    await this.ctx.storage.put<SentRoute>(key, { workspaceId, sentAt: Date.now() });
    console.log(
      JSON.stringify({
        msg: "relayrunner run sent",
        routeId: route.id,
        machineId: route.machineId,
        repo: route.repo,
        runId: route.runId,
        jobId: route.jobId,
        installationId: route.installationId,
        runnerId: jit.runnerId,
        runnerLabels: jit.labels,
      }),
    );
    return "sent";
  }

  /**
   * Tells the machine's CLI it was paused or resumed, if it's online. Routing reads the pause from
   * D1, so this is only so `relayrunner connect` can say so.
   */
  async notifyPaused(paused: boolean, by: string | null): Promise<void> {
    this.onlineSocket()?.send(pausedFrame(paused, by));
  }

  /** Closes the machine's socket for good. DELETE /api/machines/:id calls this on revoke. */
  async revoke(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      close(ws, CLOSE.revoked, "revoked");
      const session = attachment(ws);
      if (session) await this.disconnected(session, "revoked");
    }
  }

  // The machine's progress on a route. Once the job has started (the machine now says busy) or
  // the runner failed, the route stops holding the machine in the Router.
  private async onJob(machineId: string, job: JobMessage) {
    const key = SENT_KEY + job.routeId;
    const sent = await this.ctx.storage.get<SentRoute>(key);
    console.log(
      JSON.stringify({
        msg: "relayrunner machine job",
        machineId,
        routeId: job.routeId,
        state: job.state,
        message: job.message,
        known: Boolean(sent),
      }),
    );
    if (!sent) return;
    await this.env.ROUTER.getByName(sent.workspaceId).release(job.routeId);
    if (job.state !== "started") await this.ctx.storage.delete(key);
  }

  private onlineSocket() {
    const now = Date.now();
    return (
      this.ctx
        .getWebSockets()
        .find((ws) => ws.readyState === WebSocket.OPEN && statusOf(attachment(ws), now).online) ??
      null
    );
  }

  // Logs that an online machine went offline. A socket that never said hello was never online, so
  // it logs nothing.
  private async disconnected(session: SessionState, reason: DisconnectReason) {
    if (!session.hello) return;
    await recordMachineEvent(createDb(this.env.DB), session.machineId, {
      type: "machine.disconnected",
      data: { reason },
    });
  }

  // last_seen_at is written when a connection opens or ends, not on every heartbeat. While the
  // machine is online, status() is the live answer.
  private async touch(machineId: string) {
    await createDb(this.env.DB)
      .update(schema.machine)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.machine.id, machineId));
  }
}

function pausedFrame(paused: boolean, by: string | null) {
  return encodeMessage({ v: PROTOCOL_VERSION, type: "paused", paused, by });
}

// Close codes this side sends. When the machine echoes one back, webSocketClose sees it again.
const OWN_CLOSE_CODES = new Set<number>(Object.values(CLOSE));

function attachment(ws: WebSocket) {
  return ws.deserializeAttachment() as SessionState | null;
}

// Closing an already-closed socket throws; that's fine here.
function close(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}
