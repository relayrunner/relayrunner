import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseMachineMessage, type MachineMessage } from "@relayrunner/machine-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { backoff, connect, connectUrl, type ConnectionEvent } from "./connection.ts";
import type { JobUpdate } from "./job.ts";

const TOKEN = "rrm_test";
const hello = { machineId: "m1", os: "linux", arch: "x64", runnerVersion: "2.329.0" } as const;

// A stand-in for the gateway's /api/machines/connect behind Cloudflare: rejects a wrong token
// with 401, answers a plain GET with a good one with 426, answers an upgrade without a WebSocket
// key with 400 as the edge does, and records what each connection sends.
interface Gateway {
  server: string;
  connections: Connection[];
  next: () => Promise<Connection>;
  // `valid` false rejects every token. `rotated` are tokens the gateway sent that also work.
  tokens: { valid: boolean; rotated: string[] };
  close: () => Promise<void>;
}
interface Connection {
  socket: ServerSocket;
  request: IncomingMessage;
  messages: MachineMessage[];
  waitFor: (predicate: (message: MachineMessage) => boolean) => Promise<MachineMessage>;
}

const gateways: Gateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

async function startGateway(): Promise<Gateway> {
  const tokens = { valid: true, rotated: [] as string[] };
  const authorized = (request: IncomingMessage) =>
    tokens.valid &&
    [TOKEN, ...tokens.rotated].some((token) => request.headers.authorization === `Bearer ${token}`);
  const http: Server = createServer((request, response) => {
    response.statusCode = authorized(request) ? 426 : 401;
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const connections: Connection[] = [];
  const waiting: ((connection: Connection) => void)[] = [];

  http.on("upgrade", (request, socket, head) => {
    if (!request.headers["sec-websocket-key"]) {
      socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    if (request.url !== "/api/machines/connect" || !authorized(request)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const messages: MachineMessage[] = [];
      const listeners: (() => void)[] = [];
      ws.on("message", (data) => {
        const parsed = parseMachineMessage(String(data));
        if (!parsed.ok) throw new Error(parsed.error);
        messages.push(parsed.message);
        for (const listener of listeners.splice(0)) listener();
      });
      const connection: Connection = {
        socket: ws,
        request,
        messages,
        waitFor: (predicate) =>
          new Promise((resolve) => {
            const check = () => {
              const found = messages.find(predicate);
              if (found) resolve(found);
              else listeners.push(check);
            };
            check();
          }),
      };
      connections.push(connection);
      waiting.shift()?.(connection);
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const gateway: Gateway = {
    server: `http://127.0.0.1:${port}`,
    connections,
    tokens,
    next: () =>
      new Promise((resolve) => {
        const index = connections.length;
        const poll = () => (connections[index] ? resolve(connections[index]) : waiting.push(poll));
        poll();
      }),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
  gateways.push(gateway);
  return gateway;
}

function start(gateway: Gateway, overrides: Partial<Parameters<typeof connect>[0]> = {}) {
  const stop = new AbortController();
  const events: ConnectionEvent[] = [];
  const end = connect({
    server: gateway.server,
    token: TOKEN,
    hello,
    runJob: async () => ({}),
    onEvent: (event) => events.push(event),
    signal: stop.signal,
    minBackoffMs: 10,
    maxBackoffMs: 20,
    ...overrides,
  });
  return { stop, events, end };
}

describe("connect", () => {
  test("authenticates with the machine token, then says hello and its status", async () => {
    const gateway = await startGateway();
    const { stop, end } = start(gateway, { heartbeatMs: 20 });
    const connection = await gateway.next();

    expect(connection.request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    await connection.waitFor(() => connection.messages.length >= 3);
    expect(connection.messages[0]).toEqual({ v: 1, type: "hello", ...hello, slots: 1 });
    // The status right after hello, then at least one heartbeat.
    expect(connection.messages.slice(1, 3)).toEqual([
      { v: 1, type: "status", state: "idle", running: 0 },
      { v: 1, type: "status", state: "idle", running: 0 },
    ]);

    stop.abort();
    expect(await end).toEqual({ reason: "stopped" });
  });

  test("saves a token the gateway sends, says so, and connects with it next time", async () => {
    const gateway = await startGateway();
    const saved: string[] = [];
    const { stop, end } = start(gateway, { saveToken: (token) => saved.push(token) });
    const first = await gateway.next();
    expect(await first.waitFor((m) => m.type === "hello")).toMatchObject({ rotatesToken: true });

    gateway.tokens.rotated.push("rrm_next");
    first.socket.send(JSON.stringify({ v: 1, type: "token", token: "rrm_next" }));
    await first.waitFor((m) => m.type === "token_saved");
    expect(saved).toEqual(["rrm_next"]);

    first.socket.close(4000, "heartbeat timeout");
    const second = await gateway.next();
    expect(second.request.headers.authorization).toBe("Bearer rrm_next");

    stop.abort();
    expect(await end).toEqual({ reason: "stopped" });
  });

  test("keeps the old token, and doesn't say saved, when it can't save the new one", async () => {
    const gateway = await startGateway();
    const { stop, events, end } = start(gateway, {
      saveToken: () => {
        throw new Error("disk full");
      },
    });
    const first = await gateway.next();
    await first.waitFor((m) => m.type === "status");
    first.socket.send(JSON.stringify({ v: 1, type: "token", token: "rrm_next" }));
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "token-not-saved", message: "disk full" }),
    );

    first.socket.close(4000, "heartbeat timeout");
    const second = await gateway.next();
    expect(second.request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(first.messages.map((m) => m.type)).not.toContain("token_saved");

    stop.abort();
    expect(await end).toEqual({ reason: "stopped" });
  });

  test("reports being paused and resumed, and stays online", async () => {
    const gateway = await startGateway();
    const { stop, events, end } = start(gateway);
    const connection = await gateway.next();
    await connection.waitFor((m) => m.type === "status");

    connection.socket.send(JSON.stringify({ v: 1, type: "paused", paused: true, by: "Zach" }));
    connection.socket.send(JSON.stringify({ v: 1, type: "paused", paused: false, by: null }));
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "paused")).toEqual([
        { type: "paused", paused: true, by: "Zach" },
        { type: "paused", paused: false, by: null },
      ]),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: "gateway-error" }));

    stop.abort();
    expect(await end).toEqual({ reason: "stopped" });
  });

  test("runs a job: busy, job progress, then idle again", async () => {
    const gateway = await startGateway();
    let finish!: () => void;
    const { stop, end } = start(gateway, {
      runJob: (run, _slot, report) => {
        report({ routeId: run.routeId, state: "started" });
        return new Promise<void>((resolve) => {
          finish = () => {
            report({ routeId: run.routeId, state: "finished" });
            resolve();
          };
        });
      },
    });
    const connection = await gateway.next();
    await connection.waitFor((m) => m.type === "status");

    connection.socket.send(JSON.stringify({ v: 1, type: "run", routeId: "r1", jitConfig: "x" }));
    await connection.waitFor((m) => m.type === "job" && m.state === "started");
    // One slot: a second job is turned down while the first runs.
    connection.socket.send(JSON.stringify({ v: 1, type: "run", routeId: "r2", jitConfig: "y" }));
    await connection.waitFor((m) => m.type === "job" && m.routeId === "r2");
    finish();
    await connection.waitFor((m) => m.type === "job" && m.state === "finished");
    await connection.waitFor(
      (m) => m.type === "status" && m.state === "idle" && connection.messages.indexOf(m) > 3,
    );

    expect(connection.messages.slice(1)).toEqual([
      { v: 1, type: "status", state: "idle", running: 0 },
      { v: 1, type: "status", state: "busy", running: 1 },
      { v: 1, type: "job", routeId: "r1", state: "started" },
      {
        v: 1,
        type: "job",
        routeId: "r2",
        state: "failed",
        message: "The machine is already running a job.",
      },
      { v: 1, type: "job", routeId: "r1", state: "finished" },
      { v: 1, type: "status", state: "idle", running: 0 },
    ]);
    stop.abort();
    await end;
  });

  test("runs jobs in parallel up to its slots, and turns down one more", async () => {
    const gateway = await startGateway();
    const finish = new Map<string, (failed?: boolean) => void>();
    const slots: Record<string, number> = {};
    const { stop, end, events } = start(gateway, {
      slots: 2,
      runJob: (run, slot, report) => {
        slots[run.routeId] = slot;
        report({ routeId: run.routeId, state: "started" });
        return new Promise<void>((resolve) => {
          finish.set(run.routeId, (failed) => {
            report(
              failed
                ? { routeId: run.routeId, state: "failed", message: "run.sh exited with 1" }
                : { routeId: run.routeId, state: "finished" },
            );
            resolve();
          });
        });
      },
    });
    const connection = await gateway.next();
    expect(await connection.waitFor((m) => m.type === "hello")).toMatchObject({ slots: 2 });
    await connection.waitFor((m) => m.type === "status");
    const send = (routeId: string) =>
      connection.socket.send(JSON.stringify({ v: 1, type: "run", routeId, jitConfig: "x" }));
    const status = (running: number) =>
      connection.waitFor((m) => m.type === "status" && m.running === running);

    send("r1");
    send("r2");
    await connection.waitFor((m) => m.type === "job" && m.routeId === "r2");
    await status(2);
    expect(slots).toEqual({ r1: 1, r2: 2 });

    send("r3");
    expect(await connection.waitFor((m) => m.type === "job" && m.routeId === "r3")).toEqual({
      v: 1,
      type: "job",
      routeId: "r3",
      state: "failed",
      message: "The machine is already running 2 jobs.",
    });
    expect(events).toContainEqual({ type: "run-refused", routeId: "r3", running: 2 });

    // A failed job frees its slot like a finished one, and the next run takes the free slot.
    finish.get("r1")!(true);
    await connection.waitFor((m) => m.type === "job" && m.routeId === "r1" && m.state === "failed");
    send("r4");
    await connection.waitFor((m) => m.type === "job" && m.routeId === "r4");
    expect(slots.r4).toBe(1);
    finish.get("r2")!();
    finish.get("r4")!();
    await connection.waitFor(
      (m) => m.type === "job" && m.routeId === "r4" && m.state === "finished",
    );
    await connection.waitFor(
      (m) => m.type === "status" && m.running === 0 && connection.messages.indexOf(m) > 2,
    );

    const statuses = connection.messages
      .filter((m) => m.type === "status")
      .map((m) => (m.type === "status" ? [m.state, m.running] : null));
    expect(statuses).toEqual([
      ["idle", 0],
      ["busy", 1],
      ["busy", 2],
      ["busy", 1],
      ["busy", 2],
      ["busy", 1],
      ["idle", 0],
    ]);
    stop.abort();
    await end;
  });

  test("reconnects after a drop and says hello again", async () => {
    const gateway = await startGateway();
    const { stop, end, events } = start(gateway);
    const first = await gateway.next();
    await first.waitFor((m) => m.type === "status");
    first.socket.close(4000, "heartbeat timeout");

    const second = await gateway.next();
    expect(await second.waitFor((m) => m.type === "hello")).toMatchObject({ machineId: "m1" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "disconnected", code: 4000, reason: "heartbeat timeout" }),
    );
    stop.abort();
    expect(await end).toEqual({ reason: "stopped" });
  });

  test("job updates sent while disconnected arrive after the next hello", async () => {
    const gateway = await startGateway();
    let report!: (update: JobUpdate) => void;
    const { stop, end } = start(gateway, {
      runJob: (_run, _slot, r) => {
        report = r;
        return new Promise(() => {});
      },
    });
    const first = await gateway.next();
    first.socket.send(JSON.stringify({ v: 1, type: "run", routeId: "r1", jitConfig: "x" }));
    await first.waitFor((m) => m.type === "status" && m.state === "busy");
    first.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 5));
    report({ routeId: "r1", state: "started" });

    const second = await gateway.next();
    await second.waitFor((m) => m.type === "job");
    expect(second.messages.map((m) => m.type)).toEqual(["hello", "status", "job"]);
    expect(second.messages[1]).toEqual({ v: 1, type: "status", state: "busy", running: 1 });
    stop.abort();
    await end;
  });

  test.each([
    [4001, { reason: "revoked" }],
    [4002, { reason: "replaced" }],
  ] as const)("close %i ends without reconnecting", async (code, expected) => {
    const gateway = await startGateway();
    const { end } = start(gateway);
    const connection = await gateway.next();
    await connection.waitFor((m) => m.type === "status");
    connection.socket.close(code);
    expect(await end).toEqual(expected);
    expect(gateway.connections).toHaveLength(1);
  });

  test("a protocol rejection ends with the gateway's error", async () => {
    const gateway = await startGateway();
    const { end } = start(gateway);
    const connection = await gateway.next();
    await connection.waitFor((m) => m.type === "status");
    connection.socket.send(
      JSON.stringify({
        v: 1,
        type: "error",
        code: "version_mismatch",
        message: "expected protocol version 2, got 1",
      }),
    );
    connection.socket.close(1008, "protocol error");
    expect(await end).toEqual({
      reason: "rejected",
      message: "expected protocol version 2, got 1",
    });
  });

  test("a token the gateway refuses at the upgrade means revoked", async () => {
    const gateway = await startGateway();
    gateway.tokens.valid = false;
    const { end } = start(gateway);
    expect(await end).toEqual({ reason: "revoked" });
  });

  test("keeps retrying while the gateway is unreachable", async () => {
    const gateway = await startGateway();
    const server = gateway.server;
    await gateway.close();
    gateways.length = 0;
    const stop = new AbortController();
    const events: ConnectionEvent[] = [];
    const end = connect({
      server,
      token: TOKEN,
      hello,
      runJob: async () => ({}),
      onEvent: (event) => {
        events.push(event);
        if (event.type === "connecting" && event.attempt === 3) stop.abort();
      },
      signal: stop.signal,
      minBackoffMs: 5,
      maxBackoffMs: 10,
    });
    expect(await end).toEqual({ reason: "stopped" });
    expect(events.filter((e) => e.type === "disconnected")).toHaveLength(2);
  });
});

test("connectUrl swaps the scheme", () => {
  expect(connectUrl("https://app.relayrunner.dev")).toBe(
    "wss://app.relayrunner.dev/api/machines/connect",
  );
  expect(connectUrl("http://localhost:8787")).toBe("ws://localhost:8787/api/machines/connect");
});

test("backoff doubles up to the cap, with jitter", () => {
  const mid = () => 0.5;
  expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoff(n, 1000, 30_000, mid))).toEqual([
    1000, 2000, 4000, 8000, 16000, 30000, 30000,
  ]);
  expect(backoff(1, 1000, 30_000, () => 0)).toBe(750);
  expect(backoff(1, 1000, 30_000, () => 1)).toBe(1250);
});
