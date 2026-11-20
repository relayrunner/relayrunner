// The Blacksmith container's server (Dockerfile). The API's BlacksmithCli Durable Object starts the
// container, POSTs one request to /run, and stops the container once it answers. Each request logs
// in to Blacksmith's CLI with the workspace's org token in a fresh home directory, runs the read
// commands in commands.ts, and deletes that directory, so no credentials outlive the request.
//
// Node runs this file as TypeScript directly (type stripping), so it uses no TS-only syntax.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAuthFailure,
  jobsArgs,
  jobsSince,
  loginArgs,
  MAX_JOB_PAGES,
  nextCursor,
  rfc3339,
  scrub,
  usageArgs,
  validOrganization,
  verifyArgs,
} from "./commands.ts";
import { BLACKSMITH_PORT, type CliRequest, type CliResponse } from "./protocol.ts";

// One CLI call that takes longer than this is stopped.
const COMMAND_TIMEOUT_MS = 60_000;
// Requests are a few hundred bytes; anything much bigger isn't one.
const MAX_BODY_BYTES = 16_384;

class CliError extends Error {
  reason: "auth" | "error";
  constructor(reason: "auth" | "error", message: string) {
    super(message);
    this.reason = reason;
  }
}

// Runs the CLI with `home` as its home directory, writing `stdin` if given.
function blacksmith(args: string[], home: string, stdin?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("blacksmith", args, {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        BLACKSMITH_DISABLE_AUTO_UPDATE: "1",
        NO_COLOR: "1",
      },
      timeout: COMMAND_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` }),
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

// Runs one command and parses its JSON, throwing a CliError the API can map.
async function json(args: string[], home: string, token: string, stdin?: string) {
  const { code, stdout, stderr } = await blacksmith(args, home, stdin);
  const output = scrub(`${stderr}\n${code === 0 ? "" : stdout}`, token);
  if (code !== 0) {
    throw new CliError(
      isAuthFailure(output) ? "auth" : "error",
      `blacksmith ${args.slice(0, 2).join(" ")} exited ${code}: ${output}`,
    );
  }
  if (!stdin) {
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new CliError("error", `blacksmith ${args.slice(0, 2).join(" ")} didn't print JSON`);
    }
  }
  return null;
}

export async function run(request: CliRequest): Promise<CliResponse> {
  const { token, organization } = request;
  if (typeof token !== "string" || !token || !validOrganization(organization))
    return { ok: false, reason: "error", message: "the request needs a token and an organization" };
  const home = await mkdtemp(join(tmpdir(), "blacksmith-"));
  try {
    await json(loginArgs(organization), home, token, `${token}\n`);
    if (request.kind === "verify")
      return { ok: true, usage: await json(verifyArgs(), home, token), jobPages: [] };
    const start = rfc3339(request.start);
    const end = rfc3339(request.end);
    if (!start || !end)
      return { ok: false, reason: "error", message: "start and end must be dates" };
    const usage = await json(usageArgs(start, end), home, token);
    const since = jobsSince(new Date(start), new Date(end));
    const jobPages: unknown[] = [];
    // A cursor seen before would only read the same page again.
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await json(jobsArgs(since, cursor), home, token);
      jobPages.push(page);
      if (cursor) seen.add(cursor);
      cursor = nextCursor(page, new Date(start));
    } while (cursor && !seen.has(cursor) && jobPages.length < MAX_JOB_PAGES);
    return { ok: true, usage, jobPages };
  } catch (error) {
    return error instanceof CliError
      ? { ok: false, reason: error.reason, message: error.message }
      : { ok: false, reason: "error", message: scrub(String(error), token) };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error("request too large");
  }
  return JSON.parse(body);
}

const isRequest = (value: unknown): value is CliRequest =>
  !!value &&
  typeof value === "object" &&
  ((value as { kind?: unknown }).kind === "verify" ||
    (value as { kind?: unknown }).kind === "usage");

const server = createServer(async (request, response) => {
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const path = new URL(request.url ?? "/", "http://blacksmith").pathname;
  if (path === "/health") return reply(200, { ok: true });
  if (path !== "/run" || request.method !== "POST") return reply(404, { error: "not_found" });
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return reply(400, { ok: false, reason: "error", message: "the request isn't JSON" });
  }
  if (!isRequest(body))
    return reply(400, { ok: false, reason: "error", message: "unknown request" });
  reply(200, await run(body));
});

if (import.meta.main)
  server.listen(BLACKSMITH_PORT, () => console.log(`blacksmith server on :${BLACKSMITH_PORT}`));
