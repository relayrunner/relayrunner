import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import type { DisconnectReason } from "@relayrunner/activity";
import { recordMachineEvent } from "../activity.ts";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import { encodeMessage, PROTOCOL_VERSION, type JobMessage } from "@relayrunner/machine-protocol";
import {
  appInstallationToken,
  deleteRunner,
  runnerOnline,
  type RunnerScope,
} from "../github-app.ts";
import { installationRunnerScope } from "../installations.ts";
import { setJobUsage } from "../jobs.ts";
import { mintMachineRunner } from "../machine-runner.ts";
import { originFromJson, type RequestOrigin } from "../device-origin.ts";
import { sendEmail } from "../email.ts";
import {
  helloChanged,
  helloColumns,
  issuePendingToken,
  pausedByName,
  promotePendingToken,
} from "../machines.ts";
import { placeNow, ROUTE_TTL_MS, takeHold, type MachineHold, type Route } from "../routing.ts";
import { jobStillQueued, LOST_GRACE_MS } from "../stranded-jobs.ts";
import { errorMessage } from "../webhook-queue.ts";
import { annotate, traced } from "../tracing.ts";
import {
  CLOSE,
  handleFrame,
  HEARTBEAT_TIMEOUT_MS,
  isStale,
  isTakeover,
  MACHINE_ID_HEADER,
  MACHINE_ORIGIN_HEADER,
  newSession,
  OFFLINE,
  statusOf,
  type MachineStatus,
  type SessionState,
} from "./machine-session.ts";

// "wrong_place": the machine reconnected without the place the job was routed to (placeNow).
export type RunResult = "sent" | "already_sent" | "offline" | "wrong_place";

// What MachineLink keeps for a route it handed to the machine, until the machine says the job is
// over. Its presence stops a redelivered webhook from minting a second runner.
interface SentRoute {
  workspaceId: string;
  // The job it was sent for. A re-run routed again on the same route is another job.
  jobId?: number;
  // Unset while the JIT config is being minted.
  sentAt?: number;
  // The job's runner and where it's registered, so a job that never reached it can go elsewhere
  // (src/stranded-jobs.ts). Missing from routes sent before this was kept.
  runner?: {
    machineId: string;
    installationId: number;
    repo: string;
    id: number;
    scope: RunnerScope;
  };
  // When to check that the job reached its runner, set when the machine drops (watchSent).
  checkAt?: number;
  // The machine said the runner is over (finished or failed), so it can't take the job.
  runnerGone?: boolean;
}

const SENT_KEY = "sent:";
// One per route holding a slot for its job (MachineHold), whichever workspace made it.
const HOLD_KEY = "hold:";

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
    annotate({ "relayrunner.machine_id": machineId });

    // One socket per machine: a newer connection wins, so a restarted CLI never waits for the
    // old socket to time out. When it pushes out a live connection from another address, someone
    // else may have the token, so the owner hears about it.
    const now = Date.now();
    const from = originFromJson(request.headers.get(MACHINE_ORIGIN_HEADER));
    let takenFrom: RequestOrigin | undefined;
    const replaced = this.ctx.getWebSockets();
    for (const old of replaced) {
      const session = attachment(old);
      if (session && isTakeover(session, from, now)) takenFrom = session.from;
      close(old, CLOSE.replaced, "replaced");
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(newSession(machineId, now, from));
    // A restarted CLI may have left its runners behind, so check the jobs sent to them.
    if (replaced.length > 0) await this.watchSent(now);
    await this.armAlarm(now + HEARTBEAT_TIMEOUT_MS);
    await this.touch(machineId);
    // Not awaited: the email shouldn't hold up the new connection, and the socket keeps this
    // object alive while it sends.
    if (takenFrom && from)
      this.ctx.waitUntil(
        this.reportTakeover(machineId, takenFrom, from, now).catch((error: unknown) =>
          console.error(
            JSON.stringify({
              msg: "machine takeover not reported",
              machineId,
              error: String(error),
            }),
          ),
        ),
      );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, frame: string | ArrayBuffer) {
    const session = attachment(ws);
    if (!session) return close(ws, CLOSE.policy, "unknown socket");
    annotate({ "relayrunner.machine_id": session.machineId });
    const outcome = handleFrame(session, frame, Date.now());
    ws.serializeAttachment(outcome.state);
    // The first hello is when the machine comes online. A paused machine hears so right away.
    if (!session.hello && outcome.state.hello) {
      const db = createDb(this.env.DB);
      await recordMachineEvent(db, session.machineId, {
        type: "machine.connected",
        data: {
          runnerVersion: outcome.state.hello.runnerVersion ?? null,
          cliVersion: outcome.state.hello.cliVersion ?? null,
        },
      });
      const machine = await saveHello(db, session.machineId, outcome.state.hello);
      if (machine?.pausedAt) ws.send(pausedFrame(true, await pausedByName(db, machine)));
      // Rotate the token on every connect, so a copy of the token file taken earlier stops
      // working once the CLI saves the new one (TokenMessage in @relayrunner/machine-protocol).
      // Only for a socket that's still open: a newer connection that replaced it during the
      // awaits above rotates for itself, and overwriting its pending token would strand it.
      if (outcome.state.hello.rotatesToken && ws.readyState === WebSocket.OPEN) {
        const issued = await issuePendingToken(db, session.machineId);
        const current = attachment(ws);
        if (issued && current && ws.readyState === WebSocket.OPEN) {
          // Frames handled during the awaits (the status after hello) are in the attachment now.
          ws.serializeAttachment({ ...current, pendingTokenHash: issued.hash });
          ws.send(encodeMessage({ v: PROTOCOL_VERSION, type: "token", token: issued.token }));
        }
      }
    }
    if ("promote" in outcome && outcome.promote)
      await promotePendingToken(createDb(this.env.DB), session.machineId, outcome.promote);
    // A status can change what the hello said, such as the runner version after the CLI updated
    // it while connected.
    if (session.hello && outcome.state.hello && outcome.state.hello !== session.hello)
      await saveHello(createDb(this.env.DB), session.machineId, outcome.state.hello);
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
    annotate({ "relayrunner.machine_id": session.machineId });
    await this.touch(session.machineId);
    // A close this side started (timeout, revoke, replaced, protocol error) was logged when it
    // closed, or deliberately not logged (replaced), so only the machine's own close counts here.
    if (!OWN_CLOSE_CODES.has(code)) await this.disconnected(session, "closed");
  }

  async webSocketError(ws: WebSocket) {
    const session = attachment(ws);
    if (!session) return;
    annotate({ "relayrunner.machine_id": session.machineId });
    await this.touch(session.machineId);
  }

  // Closes sockets that have gone quiet, and checks again while any remain. Also checks the jobs
  // sent to the machine that are due (checkSent).
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
    const next = Math.min(
      earliest === undefined ? Infinity : earliest + HEARTBEAT_TIMEOUT_MS,
      (await this.checkSent(now)) ?? Infinity,
    );
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }

  // Sets the alarm for `at`, unless it's already set sooner.
  private async armAlarm(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // The machine dropped: each job sent to it that may not have reached its runner gets checked
  // after LOST_GRACE_MS (checkSent). Also forgets routes older than any job could still be queued.
  private async watchSent(now: number) {
    const sent = [...(await this.ctx.storage.list<SentRoute>({ prefix: SENT_KEY }))];
    const live = (r: SentRoute) => now - (r.sentAt ?? now) <= ROUTE_TTL_MS;
    const expired = sent.filter(([, r]) => !live(r)).map(([key]) => key);
    if (expired.length > 0) await this.ctx.storage.delete(expired.slice(0, 128));
    const checkAt = now + LOST_GRACE_MS;
    const watch = Object.fromEntries(
      sent
        .filter(([, r]) => r.runner && r.checkAt === undefined && live(r))
        .map(([key, r]) => [key, { ...r, checkAt }]),
    );
    if (Object.keys(watch).length === 0) return;
    await this.ctx.storage.put(watch);
    await this.armAlarm(checkAt);
  }

  // Checks each sent job that's due, and returns when the next one is.
  private async checkSent(now: number): Promise<number | undefined> {
    const sent = await this.ctx.storage.list<SentRoute>({ prefix: SENT_KEY });
    let next = Infinity;
    for (const [key, route] of sent) {
      if (route.checkAt === undefined) continue;
      const at = route.checkAt > now ? route.checkAt : await this.checkOne(key, route, now);
      if (at !== undefined) next = Math.min(next, at);
    }
    return next === Infinity ? undefined : next;
  }

  // Checks one sent job now (recover). When GitHub couldn't say, returns when to look again.
  private async checkOne(key: string, route: SentRoute, now: number) {
    const routeId = key.slice(SENT_KEY.length);
    // Cleared first, so a check that runs meanwhile (another job report) leaves it alone.
    await this.ctx.storage.put<SentRoute>(key, { ...route, checkAt: undefined });
    try {
      await this.recover(routeId, route);
      return undefined;
    } catch (error) {
      const checkAt = now + LOST_GRACE_MS;
      await this.ctx.storage.put<SentRoute>(key, { ...route, checkAt });
      console.warn(
        JSON.stringify({
          msg: "relayrunner sent job not checked",
          routeId,
          error: errorMessage(error),
        }),
      );
      return checkAt;
    }
  }

  /**
   * Sends a job back to its Router when it never reached the runner minted for it: GitHub still has
   * it queued, and the runner is over or not connected to GitHub. The runner is removed first, so a
   * machine that wakes up later can't take the job too; if GitHub won't remove it, it may have just
   * taken the job, and this throws to look again later. A job that started stays.
   */
  private async recover(routeId: string, sent: SentRoute) {
    const key = SENT_KEY + routeId;
    const { runner, jobId } = sent;
    let token: string | undefined;
    const getToken = async () =>
      (token ??= await appInstallationToken(this.env, runner!.installationId));
    const stays =
      !runner ||
      jobId === undefined ||
      !(await jobStillQueued(createDb(this.env.DB), getToken, runner.repo, jobId)) ||
      (!sent.runnerGone && (await runnerOnline(await getToken(), runner.scope, runner.id)));
    if (stays) {
      // It started, or its runner is still there to take it. Kept for a redelivered webhook until
      // the machine says the runner is over.
      if (sent.runnerGone) await this.ctx.storage.delete(key);
      return;
    }
    await deleteRunner(await getToken(), runner.scope, runner.id);
    await this.ctx.storage.delete([key, HOLD_KEY + routeId]);
    console.warn(
      JSON.stringify({
        msg: "relayrunner job never reached its runner",
        routeId,
        jobId,
        runnerGone: Boolean(sent.runnerGone),
      }),
    );
    await this.env.ROUTER.getByName(sent.workspaceId).requeueSent(routeId, jobId, runner.machineId);
  }

  /**
   * Online (said hello, heard from within the heartbeat timeout), idle or busy, with its slots and
   * the jobs it reports running.
   */
  async status(): Promise<MachineStatus> {
    const ws = this.onlineSocket();
    return ws ? statusOf(attachment(ws), Date.now()) : OFFLINE;
  }

  /**
   * Holds one of the machine's slots for a route a Router is making, unless the machine has none
   * free: its other unexpired holds plus the jobs it reports running fill its slots (takeHold).
   * False then, and the Router tries its next machine. The reads and the write run with no other
   * call in between (a Durable Object's input gate stays closed across storage calls), so when
   * several workspaces pick this machine at once they can't take more slots than it has. A hold
   * ends when the machine reports the route's job started or failed, or after ROUTE_HOLD_MS.
   */
  async reserve(want: { routeId: string; workspaceId: string }): Promise<boolean> {
    const now = Date.now();
    const stored = await this.ctx.storage.list<MachineHold>({ prefix: HOLD_KEY });
    const lapsed = [...stored].filter(([, hold]) => now >= hold.until).map(([key]) => key);
    if (lapsed.length > 0) await this.ctx.storage.delete(lapsed);
    const { slots, running } = await this.status();
    const hold = takeHold([...stored.values()], want, { slots, running }, now);
    if (!hold) return false;
    await this.ctx.storage.put(HOLD_KEY + want.routeId, hold);
    return true;
  }

  /**
   * Gives back the slot a route held, when its job is going elsewhere: the machine went offline
   * before the job was sent (Router.requeue), so a reconnect finds the slot free.
   */
  async dropHold(routeId: string): Promise<void> {
    await this.ctx.storage.delete(HOLD_KEY + routeId);
  }

  /**
   * Hands a claimed route's job to the machine: mints a one-job runner on the route's label, on
   * the job's own repo (src/machine-runner.ts), named after the machine, and sends it in a `run`
   * message. Safe to call again for the same route and job (a redelivered webhook): only the
   * first call mints. A re-run routed again on the route is a new job, and is sent again.
   * "offline" means the machine has no live socket: the Router puts the job back in line
   * (Router.requeue).
   */
  async run(work: { route: Route; workspaceId: string }): Promise<RunResult> {
    const { route } = work;
    return traced(
      "machine.run",
      {
        "relayrunner.workspace_id": work.workspaceId,
        "relayrunner.machine_id": route.machineId,
        "relayrunner.route_id": route.id,
        "github.repository": route.repo,
        "github.job_id": route.jobId,
      },
      async (span) => {
        const result = await this.send(work);
        span.setAttribute("relayrunner.run.result", result);
        return result;
      },
    );
  }

  private async send(work: { route: Route; workspaceId: string }): Promise<RunResult> {
    const { route, workspaceId } = work;
    const key = SENT_KEY + route.id;
    const sent = await this.ctx.storage.get<SentRoute>(key);
    if (sent && sent.jobId === route.jobId) return "already_sent";
    const socket = this.onlineSocket();
    if (!socket) return "offline";
    if (!placeOn(socket, route)) return "wrong_place";
    await this.ctx.storage.put<SentRoute>(key, { workspaceId, jobId: route.jobId });

    let jit, scope;
    try {
      const token = await appInstallationToken(this.env, route.installationId);
      ({ jit, scope } = await mintMachineRunner(token, route, () =>
        installationRunnerScope(createDb(this.env.DB), route.installationId, route.repo),
      ));
    } catch (error) {
      // Let a retry of the webhook try again.
      await this.ctx.storage.delete(key);
      throw error;
    }
    // The socket may have closed while minting; the runner then expires unused.
    const live = this.onlineSocket() ?? socket;
    // It may also have reconnected as something else. A job routed to a VM is never sent to a
    // machine that would run it on itself.
    const place = placeOn(live, route);
    if (!place) {
      await this.ctx.storage.delete(key);
      return "wrong_place";
    }
    live.send(
      encodeMessage({
        v: PROTOCOL_VERSION,
        type: "run",
        routeId: route.id,
        jitConfig: jit.encodedJitConfig,
        ...(place === "vm" ? { isolated: true } : {}),
      }),
    );
    await this.ctx.storage.put<SentRoute>(key, {
      workspaceId,
      jobId: route.jobId,
      sentAt: Date.now(),
      runner: {
        machineId: route.machineId,
        installationId: route.installationId,
        repo: route.repo,
        id: jit.runnerId,
        scope,
      },
    });
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

  /**
   * Closes the socket and wipes this object's storage and alarm. Operator deletes call this
   * (src/admin-delete.ts) before the machine row goes, since nothing would ever call it again.
   */
  async purge(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) close(ws, CLOSE.revoked, "revoked");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // The machine's progress on a route. Once the job has started (the machine now says busy) or
  // the runner failed, the route stops holding the machine, here and in the Router that made it.
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
    await this.ctx.storage.delete(HOLD_KEY + job.routeId);
    if (!sent) return;
    const jobId = await this.env.ROUTER.getByName(sent.workspaceId).release(job.routeId);
    if (job.usage && jobId) await setJobUsage(createDb(this.env.DB), jobId, job.usage);
    if (job.state === "started") return;
    // The runner is over. If it never got the job, the job goes elsewhere now.
    const next = await this.checkOne(key, { ...sent, runnerGone: true }, Date.now());
    if (next !== undefined) await this.armAlarm(next);
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
    await this.watchSent(Date.now());
    await recordMachineEvent(createDb(this.env.DB), session.machineId, {
      type: "machine.disconnected",
      data: { reason },
    });
  }

  // Logs a takeover and emails the machine's owner, who can revoke it if it wasn't them.
  private async reportTakeover(
    machineId: string,
    was: RequestOrigin,
    now: RequestOrigin,
    at: number,
  ) {
    console.warn(
      JSON.stringify({
        msg: "machine connection taken over from another address",
        machineId,
        was,
        now,
      }),
    );
    const db = createDb(this.env.DB);
    const [row] = await db
      .select({ machineName: schema.machine.name, email: schema.user.email })
      .from(schema.machine)
      .innerJoin(schema.user, eq(schema.user.id, schema.machine.userId))
      .where(eq(schema.machine.id, machineId))
      .limit(1);
    if (!row) return;
    await sendEmail(this.env, {
      to: row.email,
      template: "machine-taken-over",
      context: {
        machineName: row.machineName,
        was,
        now,
        at: new Date(at),
      },
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

// Where the machine on this socket runs a route's job now (placeNow).
function placeOn(ws: WebSocket, route: Route) {
  const hello = attachment(ws)?.hello;
  return hello ? placeNow(route, hello) : null;
}

// Saves what a machine's hello says about it, and returns the machine as it was. Written only when
// it changed: a deploy reconnects every machine at once, and most report the same OS and device as
// last time.
async function saveHello(
  db: ReturnType<typeof createDb>,
  machineId: string,
  hello: NonNullable<SessionState["hello"]>,
) {
  const [machine] = await db
    .select()
    .from(schema.machine)
    .where(eq(schema.machine.id, machineId))
    .limit(1);
  const columns = helloColumns(hello, new Date());
  if (machine && helloChanged(machine, columns))
    await db.update(schema.machine).set(columns).where(eq(schema.machine.id, machineId));
  return machine;
}
