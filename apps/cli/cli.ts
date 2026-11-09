#!/usr/bin/env node
import { hostname } from "node:os";
import * as clack from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import { connect, type ConnectionEvent } from "./connection.ts";
import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
  type Credentials,
} from "./credentials.ts";
import { detectDevice } from "./device.ts";
import { initCommand } from "./init.ts";
import { ensureRunner, RunnerError, runnerPlatform } from "./install.ts";
import { runJob } from "./job.ts";
import { login, LoginError, openBrowser } from "./login.ts";
import { setPaused } from "./pause.ts";
import { whoami, type WhoamiResponse } from "./whoami.ts";

// The dashboard's origin. It forwards /api/* (including the machine WebSocket) to the API.
const DEFAULT_SERVER = "https://relayrunner-app.relayrun.workers.dev";

const connectCommand = defineCommand({
  meta: {
    name: "connect",
    description:
      "Put this machine online for your workspace and run the jobs the gateway sends it. Signs in on first run; Ctrl-C takes the machine offline.",
  },
  args: {
    server: {
      type: "string",
      description: `RelayRunner URL (default: $RELAYRUNNER_URL or ${DEFAULT_SERVER})`,
    },
    name: {
      type: "string",
      description: "Suggested machine name when signing in (default: this computer's hostname)",
    },
  },
  async run({ args }) {
    clack.intro("RelayRunner");
    try {
      await connectMachine(args);
    } catch (error) {
      if (!(error instanceof LoginError || error instanceof RunnerError)) throw error;
      clack.log.error(error.message);
      process.exitCode = 1;
    }
  },
});

async function connectMachine(args: { server?: string; name?: string }) {
  // An explicit --server or RELAYRUNNER_URL wins; otherwise keep the gateway this machine
  // enrolled with.
  const requested = args.server || process.env.RELAYRUNNER_URL;
  const target = runnerPlatform();
  const platform = { os: target.os === "osx" ? "macos" : "linux", arch: target.arch } as const;

  let credentials = readCredentials();
  const server = normalizeServer(requested || credentials?.server || DEFAULT_SERVER);
  if (credentials && credentials.server !== server) {
    clack.log.warn(
      `This machine is enrolled with ${credentials.server}, not ${server}. Signing in again.`,
    );
    credentials = null;
  }
  if (!credentials) {
    credentials = await signIn(server, args.name || hostname(), platform);
    writeCredentials(credentials);
    clack.log.success(
      `Enrolled as ${credentials.machine.name} in ${credentials.workspace.name}. Token saved to ${credentialsPath()}.`,
    );
  } else {
    clack.log.info(
      `Machine ${credentials.machine.name} in ${credentials.workspace.name} (${credentials.server})`,
    );
  }

  const runner = await ensureRunner({ log: (line) => clack.log.info(line) });
  // What kind of device this is and its specs, for the dashboard's badge. Best effort.
  const device = await detectDevice();

  // First Ctrl-C goes offline and lets a running job's runner exit and clean up (the terminal
  // sends it SIGINT too). A second one exits on the spot.
  const stop = new AbortController();
  const onInterrupt = () => {
    if (stop.signal.aborted) process.exit(130);
    stop.abort();
  };
  process.on("SIGINT", onInterrupt);

  let online = false;
  const end = await connect({
    server: credentials.server,
    token: credentials.token,
    hello: {
      machineId: credentials.machine.id,
      ...platform,
      runnerVersion: runner.version,
      device,
    },
    runJob: (run, report) => runJob(run, { runner, report }),
    onEvent: (event) => {
      if (event.type === "connected") online = true;
      show(event);
    },
    signal: stop.signal,
  });
  process.off("SIGINT", onInterrupt);

  switch (end.reason) {
    case "stopped":
      clack.outro("Offline.");
      break;
    case "revoked":
      deleteCredentials();
      // The saved token was already dead when this run started, so someone is here to sign in.
      // A machine revoked while online may be unattended, so that one stops and says so.
      if (!online) {
        clack.log.warn(
          "This machine was removed from the workspace or its token is no longer valid. Signing in again.",
        );
        return connectMachine({ ...args, server: credentials.server });
      }
      clack.log.error(
        "This machine was removed from the workspace or its token is no longer valid.",
      );
      clack.outro("Run `relayrunner connect` again to sign in.");
      process.exitCode = 1;
      break;
    case "replaced":
      clack.log.warn("Another `relayrunner connect` for this machine took over.");
      clack.outro("Offline here.");
      process.exitCode = 1;
      break;
    case "rejected":
      clack.log.error(`The gateway rejected this CLI: ${end.message}`);
      clack.outro("Update it with `npx relayrunner@latest connect`.");
      process.exitCode = 1;
      break;
  }
}

async function signIn(
  server: string,
  name: string,
  platform: { os: "linux" | "macos"; arch: "x64" | "arm64" },
): Promise<Credentials> {
  const waiting = clack.spinner();
  try {
    const credentials = await login({
      server,
      name,
      platform,
      onCode: ({ userCode, url }) => {
        clack.note(
          `${url}\n\nConfirm the code ${userCode} matches the one in your browser.`,
          "Sign in",
        );
        openBrowser(url);
        waiting.start("Waiting for approval in the browser");
      },
    });
    waiting.stop("Approved");
    return credentials;
  } catch (error) {
    waiting.error("Sign-in failed");
    throw error;
  }
}

function show(event: ConnectionEvent) {
  const at = new Date().toLocaleTimeString();
  switch (event.type) {
    case "connecting":
      if (event.attempt === 1) clack.log.step(`${at} Connecting…`);
      break;
    case "connected":
      clack.log.success(`${at} Online. Waiting for jobs.`);
      break;
    case "disconnected":
      clack.log.warn(
        `${at} Disconnected (${event.code}${event.reason ? ` ${event.reason}` : ""}). Retrying in ${Math.ceil(event.retryInMs / 1000)}s.`,
      );
      break;
    case "gateway-error":
      clack.log.error(`${at} Gateway: ${event.message}`);
      break;
    case "run":
      clack.log.step(`${at} Starting job ${event.routeId}`);
      break;
    case "paused":
      if (event.paused)
        clack.log.warn(
          `${at} Paused${event.by ? ` by ${event.by}` : ""}. Staying online, but new jobs skip this machine until it's resumed.`,
        );
      else
        clack.log.success(`${at} Resumed${event.by ? ` by ${event.by}` : ""}. Waiting for jobs.`);
      break;
    case "run-refused":
      clack.log.warn(`${at} Turned down job ${event.routeId}: already running one.`);
      break;
    case "job": {
      const { routeId, state, message } = event.update;
      const line = `${at} Job ${routeId} ${state}${message ? `: ${message}` : ""}`;
      if (state === "failed") clack.log.error(line);
      else if (state === "finished") clack.log.success(line);
      else clack.log.info(line);
      break;
    }
  }
}

const whoamiCommand = defineCommand({
  meta: {
    name: "whoami",
    description:
      "Show which machine and workspace this computer is signed in as, checked with the gateway.",
  },
  args: {
    server: {
      type: "string",
      description: "Only report a sign-in for this RelayRunner URL (default: the saved one)",
    },
    json: { type: "boolean", description: "Print the result as JSON" },
  },
  async run({ args }) {
    const print = (human: string, json: Record<string, unknown>) =>
      console.log(args.json ? JSON.stringify(json, null, 2) : human);

    const credentials = readCredentials();
    const requested = args.server || process.env.RELAYRUNNER_URL;
    const server = requested ? normalizeServer(requested) : credentials?.server;
    if (!credentials || credentials.server !== server) {
      print(
        credentials
          ? `Not signed in to ${server}. This machine is enrolled with ${credentials.server}.`
          : "Not signed in. Run `relayrunner connect` to sign in.",
        { status: "signed_out", server: server ?? null },
      );
      process.exitCode = 1;
      return;
    }

    const saved = {
      server: credentials.server,
      machine: credentials.machine,
      workspace: credentials.workspace,
    };
    const result = await whoami({ server: credentials.server, token: credentials.token });
    switch (result.status) {
      case "ok":
        print(describeIdentity(credentials.server, result.identity), {
          status: "ok",
          server: credentials.server,
          ...result.identity,
        });
        break;
      case "revoked":
        print(
          `${credentials.machine.name} was removed from ${credentials.workspace.name} or its token is no longer valid.\nRun \`relayrunner connect\` to sign in again.`,
          { status: "revoked", ...saved },
        );
        process.exitCode = 1;
        break;
      case "unverified":
        print(
          `${describeSaved(saved)}\n\nUnverified: ${result.reason}. This is what's saved in ${credentialsPath()}.`,
          { status: "unverified", reason: result.reason, ...saved },
        );
        break;
    }
  },
});

function describeIdentity(server: string, identity: WhoamiResponse) {
  const { machine, workspace, enrolledBy } = identity;
  const status =
    (machine.status.online
      ? `online${machine.status.state ? `, ${machine.status.state}` : ""}`
      : "offline") +
    (machine.paused ? `, paused${machine.paused.by ? ` by ${machine.paused.by}` : ""}` : "");
  const enrolled = [
    enrolledBy && `by ${enrolledBy.name} <${enrolledBy.email}>`,
    `on ${new Date(machine.createdAt).toLocaleDateString()}`,
  ]
    .filter(Boolean)
    .join(" ");
  return table(`${machine.name} (${machine.id})`, [
    ["Workspace", workspace.slug ? `${workspace.name} (${workspace.slug})` : workspace.name],
    ["Platform", [machine.os, machine.arch].filter(Boolean).join(" ") || "unknown"],
    ["Enrolled", enrolled],
    ["Status", status],
    ["Gateway", server],
  ]);
}

function describeSaved(saved: Pick<Credentials, "server" | "machine" | "workspace">) {
  return table(`${saved.machine.name} (${saved.machine.id})`, [
    ["Workspace", saved.workspace.name],
    ["Gateway", saved.server],
  ]);
}

function table(title: string, rows: [string, string][]) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return [title, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join("\n");
}

function normalizeServer(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.origin;
  } catch {
    throw new RunnerError("USAGE", `Not a valid RelayRunner URL: ${value}`);
  }
}

// `relayrunner pause` and `resume`: the same as the machine's ⋯ menu on the Runners page.
function pauseCommand(paused: boolean) {
  return defineCommand({
    meta: {
      name: paused ? "pause" : "resume",
      description: paused
        ? "Stop new jobs routing to this machine. It stays connected and finishes a job it's running."
        : "Let jobs route to this machine again after `relayrunner pause`.",
    },
    async run() {
      const credentials = readCredentials();
      if (!credentials) {
        console.error("Not signed in. Run `relayrunner connect` to sign in.");
        process.exitCode = 1;
        return;
      }
      const result = await setPaused({
        server: credentials.server,
        token: credentials.token,
        paused,
      });
      const name = credentials.machine.name;
      switch (result.status) {
        case "ok":
          console.log(
            paused
              ? `Paused ${name}. It stays connected, and new jobs will skip it.${result.busy ? "\nIt finishes the job it's running first." : ""}\nRun \`relayrunner resume\` to take jobs again.`
              : `Resumed ${name}. Jobs can route here again.`,
          );
          break;
        case "revoked":
          console.error(
            `${name} was removed from ${credentials.workspace.name} or its token is no longer valid.\nRun \`relayrunner connect\` to sign in again.`,
          );
          process.exitCode = 1;
          break;
        case "failed":
          console.error(`Couldn't ${paused ? "pause" : "resume"} ${name}: ${result.reason}.`);
          process.exitCode = 1;
          break;
      }
    },
  });
}

const main = defineCommand({
  meta: {
    name: "relayrunner",
    description: "Run GitHub Actions jobs on your machine through the RelayRunner gateway.",
  },
  subCommands: {
    connect: connectCommand,
    whoami: whoamiCommand,
    init: initCommand,
    pause: pauseCommand(true),
    resume: pauseCommand(false),
  },
});

void runMain(main);
