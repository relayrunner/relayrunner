#!/usr/bin/env node
import * as clack from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import { connect, type ConnectionEvent } from "./connection.ts";
import {
  credentialsPath,
  deleteCredentials,
  readCredentials,
  saveRotatedToken,
  withCurrentToken,
  writeCredentials,
  type Credentials,
} from "./credentials.ts";
import { detectDevice } from "./device.ts";
import { initCommand, offerSetup } from "./init.ts";
import { defaultMachineName } from "./machine-name.ts";
import { ensureRunner, RunnerError, runnerPlatform } from "./install.ts";
import { normalizeServer } from "./server.ts";
import { isolatedLauncher, prepareIsolation } from "./isolated.ts";
import { hostLauncher, prefixLines, runJob, type Launcher } from "./job.ts";
import { startLive } from "./live.ts";
import { CHECK_INTERVAL_MS, checkForUpdate, updateNotice } from "./update-check.ts";
import { cliVersion } from "./version.ts";
import { login, LoginError, openBrowser } from "./login.ts";
import { pauseMachine } from "./pause.ts";
import { ensureSlots, parseConcurrency } from "./slots.ts";
import {
  describeSharing,
  parseShareChoice,
  SHARE_CHOICES,
  setSharing,
  sharingMeaning,
  toChoice,
  toSharing,
  type ShareChoice,
} from "./share.ts";
import { whoami, type WhoamiResponse } from "./whoami.ts";
import {
  hasTeammates,
  readWorkspaces,
  sharingScope,
  workspaceNames,
  type Workspace,
} from "./workspaces.ts";
import { emptyWorkspacesNotice, workspacesCommand } from "./workspaces-command.ts";

// The dashboard's origin. It forwards /api/* (including the machine WebSocket) to the API.
const DEFAULT_SERVER = "https://app.relayrunner.app";

const connectCommand = defineCommand({
  meta: {
    name: "connect",
    description:
      "Put this machine online for your workspaces and run the jobs the gateway sends it. Signs in on first run; Ctrl-C takes the machine offline.",
  },
  args: {
    server: {
      type: "string",
      description: `RelayRunner URL (default: $RELAYRUNNER_URL or ${DEFAULT_SERVER})`,
    },
    name: {
      type: "string",
      description: "Suggested machine name when signing in (default: this computer's name)",
    },
    share: {
      type: "string",
      description:
        "Who can run jobs on this machine: only-me (jobs you started) or anyone in your workspaces. Skips the question.",
    },
    concurrency: {
      type: "string",
      description:
        "How many jobs to run at once (default: 2 with 8 or more CPU cores, otherwise 1)",
    },
    isolated: {
      type: "boolean",
      description:
        "Run each job in its own Linux VM, away from your files. Needs a Mac with Apple silicon and Apple's container tool.",
    },
    image: {
      type: "string",
      description: "With --isolated, the runner image to build on (default: GitHub's runner image)",
    },
  },
  async run({ args }) {
    clack.intro("RelayRunner");
    let concurrency: number;
    try {
      concurrency = parseConcurrency(args.concurrency);
    } catch (error) {
      clack.log.error((error as Error).message);
      process.exitCode = 1;
      return;
    }
    try {
      await connectMachine({ ...args, concurrency });
    } catch (error) {
      if (!(error instanceof LoginError || error instanceof RunnerError)) throw error;
      clack.log.error(error.message);
      process.exitCode = 1;
    }
  },
});

async function connectMachine(args: {
  server?: string;
  name?: string;
  share?: string;
  concurrency: number;
  isolated?: boolean;
  image?: string;
}) {
  const share = shareArg(args.share);
  if (args.image && !args.isolated) throw new RunnerError("USAGE", "--image goes with --isolated.");
  const host = machinePlatform();
  if (args.isolated && (host.os !== "macos" || host.arch !== "arm64"))
    throw new RunnerError("ISOLATED_UNSUPPORTED", "--isolated needs a Mac with Apple silicon.");
  // Isolated jobs run on Linux, whatever this machine is.
  const platform = args.isolated ? ({ os: "linux", arch: host.arch } as const) : host;
  let credentials = readCredentials();
  const server = serverFor(args.server, credentials);
  if (credentials && credentials.server !== server) {
    clack.log.warn(
      `This machine is enrolled with ${credentials.server}, not ${server}. Signing in again.`,
    );
    credentials = null;
  }
  if (!credentials) {
    credentials = await enroll(server, args.name, platform, share);
  } else {
    clack.log.info(`Machine ${credentials.machine.name} (${credentials.server})`);
    if (share) await applySharing(credentials, share, null);
  }

  // Run inside a repo that isn't set up yet, offer to route its jobs here (`relayrunner init`).
  // Only when someone is at the terminal to answer.
  if (process.stdin.isTTY && process.stdout.isTTY) await offerSetup();

  // Someone at the terminal hears about a newer CLI now, and again each day `connect` stays up.
  // The check runs in the background and never holds up connecting.
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  if (process.stdout.isTTY && !process.env.CI) {
    const notifyUpdate = () =>
      void checkForUpdate().then((latest) => {
        if (latest) clack.log.warn(updateNotice(latest));
      });
    notifyUpdate();
    updateTimer = setInterval(notifyUpdate, CHECK_INTERVAL_MS);
    updateTimer.unref();
  }

  const slots = args.concurrency;
  const log = (line: string) => clack.log.info(line);
  // Isolated, each job gets a fresh VM from the runner image. Otherwise each slot runs its jobs
  // in its own copy of the runner on this machine.
  let runnerVersion: string;
  let launchers: Launcher[];
  if (args.isolated) {
    const isolation = await prepareIsolation({ slots, image: args.image, log });
    runnerVersion = isolation.runnerVersion;
    launchers = Array.from({ length: slots }, () => isolatedLauncher(isolation));
    log(
      `Each job runs in its own Linux VM with ${isolation.cpus} CPUs and ${isolation.memoryGb} GB of memory.`,
    );
  } else {
    const runner = await ensureRunner({ log });
    runnerVersion = runner.version;
    launchers = ensureSlots(runner, slots, log).map(hostLauncher);
  }
  clack.log.info(
    slots === 1
      ? "Running 1 job at a time. Change with --concurrency."
      : `Running up to ${slots} jobs at once. Change with --concurrency.`,
  );
  // What kind of device this is and its specs, for the dashboard's badge. Best effort.
  const device = await detectDevice();

  const stop = new AbortController();
  // The tab's title follows the machine's state, and `p` pauses or resumes it, while someone's at
  // the terminal. On success the gateway sends `paused`, which logs it and updates the title.
  const enrolled = credentials;
  let toggling = false;
  const live = startLive({
    machine: enrolled.machine.name,
    onTogglePause: async ({ paused }) => {
      if (toggling || stop.signal.aborted) return;
      toggling = true;
      const result = await pauseMachine(enrolled, !paused);
      toggling = false;
      if (result.status === "failed")
        clack.log.error(`Couldn't ${paused ? "resume" : "pause"}: ${result.reason}.`);
    },
  });

  // First Ctrl-C goes offline and lets a running job's runner exit and clean up (the terminal
  // sends it SIGINT too). A second one exits on the spot.
  const onInterrupt = () => {
    if (stop.signal.aborted) {
      live.end();
      process.exit(130);
    }
    stop.abort();
  };
  process.on("SIGINT", onInterrupt);

  let online = false;
  let end;
  try {
    end = await connect({
      server: credentials.server,
      token: credentials.token,
      hello: {
        machineId: credentials.machine.id,
        ...platform,
        runnerVersion,
        cliVersion,
        device,
      },
      slots,
      runJob: async (run, slot, report) => {
        // With more than one slot, each line of a job's output says which slot it came from.
        const prefixed =
          slots > 1
            ? prefixLines(`[slot ${slot}] `, (chunk, stream) =>
                (stream === "stdout" ? process.stdout : process.stderr).write(chunk),
              )
            : undefined;
        try {
          return await runJob(run, {
            launcher: launchers[slot - 1],
            report,
            output: prefixed?.output,
            onChecked: (target) => {
              if (target)
                clack.log.info(
                  `${new Date().toLocaleTimeString()} Job ${run.routeId}${slots > 1 ? ` (slot ${slot})` : ""} is from ${target}`,
                );
            },
          });
        } finally {
          prefixed?.flush();
        }
      },
      // The gateway rotates the token on every connect, so an old copy of machine.json stops working.
      saveToken: (token) => saveRotatedToken(credentials, token),
      onEvent: (event) => {
        if (event.type === "connected") online = true;
        show(event, slots > 1);
        live.onEvent(event);
      },
      signal: stop.signal,
    });
  } finally {
    clearInterval(updateTimer);
    live.end();
    process.off("SIGINT", onInterrupt);
  }

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
          "This machine was removed or its token is no longer valid. If you didn't remove it, another copy of its token may have signed in elsewhere: check the Runners page. Signing in again.",
        );
        return connectMachine({ ...args, server: credentials.server });
      }
      clack.log.error(
        "This machine was removed or its token is no longer valid. If you didn't remove it, another copy of its token may have signed in elsewhere: check the Runners page and revoke it if so.",
      );
      clack.outro("Run `relayrunner connect` again to sign in.");
      process.exitCode = 1;
      break;
    case "replaced":
      clack.log.warn(
        [
          "Another `relayrunner connect` signed in as this machine and took over.",
          `If that wasn't you, someone has this machine's token: revoke it at ${credentials.server}/runners, then run \`relayrunner connect\` to sign in again.`,
        ].join("\n"),
      );
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

async function askSharing(workspaces: Workspace[]): Promise<ShareChoice | null> {
  const picked = await clack.select<ShareChoice>({
    message: "Who can run jobs on this machine?",
    options: [
      { value: "only-me", label: "Only me", hint: "jobs you started" },
      {
        value: "anyone",
        label: `Anyone in ${sharingScope(workspaces)}`,
        hint: "teammates' and bots' jobs too, from repos you can open",
      },
    ],
    initialValue: "only-me",
  });
  if (clack.isCancel(picked)) {
    clack.log.info("Keeping only-me. Change it any time with `relayrunner share`.");
    return null;
  }
  return picked;
}

// Best effort while connecting: a machine that couldn't change its sharing still connects.
async function applySharing(
  credentials: Credentials,
  choice: ShareChoice,
  workspaces: Workspace[] | null,
) {
  const result = await withCurrentToken(credentials, (token) =>
    setSharing({ server: credentials.server, token, sharing: toSharing(choice) }),
  );
  switch (result.status) {
    case "ok":
      clack.log.info(
        `Sharing: ${describeSharing(result.sharing, workspaces ? sharingScope(workspaces) : undefined)}`,
      );
      break;
    case "revoked":
      // Connecting finds out too, and signs in again or says so.
      break;
    case "failed":
      clack.log.warn(
        `Couldn't set sharing: ${result.reason}. Run \`relayrunner share ${choice}\` to try again.`,
      );
      break;
  }
}

// `relayrunner login`: the sign-in half of `connect`. It enrolls the machine and exits without
// going online, so an agent can run it start to finish. `connect` then puts the machine online.
const loginCommand = defineCommand({
  meta: {
    name: "login",
    description:
      "Sign this machine in without putting it online. You pick its workspaces when you approve it. Run `relayrunner connect` afterwards to take jobs.",
  },
  args: {
    server: {
      type: "string",
      description: `RelayRunner URL (default: $RELAYRUNNER_URL or ${DEFAULT_SERVER})`,
    },
    name: {
      type: "string",
      description: "Suggested machine name (default: this computer's name)",
    },
    share: {
      type: "string",
      description:
        "Who can run jobs on this machine: only-me (jobs you started) or anyone in your workspaces. Skips the question.",
    },
  },
  async run({ args }) {
    clack.intro("RelayRunner");
    try {
      const share = shareArg(args.share);
      const saved = readCredentials();
      const server = serverFor(args.server, saved);
      if (saved && saved.server === server) {
        const result = await withCurrentToken(saved, (token) => whoami({ server, token }));
        if (result.status !== "revoked") {
          const workspaces = result.status === "ok" ? readWorkspaces(result.identity) : null;
          if (share) await applySharing(saved, share, workspaces);
          const where = workspaces?.length ? ` in ${workspaceNames(workspaces)}` : "";
          clack.outro(
            `Already signed in as ${saved.machine.name}${where}. Run \`relayrunner connect\` to go online.`,
          );
          return;
        }
        clack.log.warn(`${saved.machine.name} is no longer signed in. Signing in again.`);
      } else if (saved) {
        clack.log.warn(
          `This machine is enrolled with ${saved.server}, not ${server}. Signing in again.`,
        );
      }
      await enroll(server, args.name, machinePlatform(), share);
      clack.outro("Run `relayrunner connect` to put this machine online.");
    } catch (error) {
      if (!(error instanceof LoginError || error instanceof RunnerError)) throw error;
      clack.log.error(error.message);
      process.exitCode = 1;
    }
  },
});

function shareArg(value: string | undefined) {
  const share = value ? parseShareChoice(value) : null;
  if (value && !share)
    throw new RunnerError(
      "USAGE",
      `--share takes ${SHARE_CHOICES.join(" or ")}, not ${JSON.stringify(value)}.`,
    );
  return share;
}

/** An explicit --server or RELAYRUNNER_URL wins; otherwise the gateway this machine enrolled with. */
function serverFor(requested: string | undefined, saved: Credentials | null) {
  return normalizeServer(
    requested || process.env.RELAYRUNNER_URL || saved?.server || DEFAULT_SERVER,
  );
}

function machinePlatform() {
  const target = runnerPlatform();
  return { os: target.os === "osx" ? "macos" : "linux", arch: target.arch } as const;
}

/** Signs in through the browser, saves the machine token, and settles who can run jobs here. */
async function enroll(
  server: string,
  name: string | undefined,
  platform: ReturnType<typeof machinePlatform>,
  share: ShareChoice | null,
) {
  const signedIn = await signIn(server, name || (await defaultMachineName()), platform);
  const { credentials, workspaces } = signedIn;
  writeCredentials(credentials);
  clack.log.success(
    `Enrolled as ${credentials.machine.name}. Token saved to ${credentialsPath()}.`,
  );
  // /device picked the workspaces it runs jobs in (#364); this is where they're changed later.
  if (workspaces.length)
    clack.log.info(
      `Runs jobs in ${workspaceNames(workspaces)}.\nChange with: relayrunner workspaces`,
    );
  // Signed in before RelayRunner is installed anywhere they belong: the machine is theirs and can
  // go online, and shows up in a workspace as soon as there is one. Or every workspace was left
  // unticked on /device.
  else clack.log.warn(await emptyWorkspacesNotice(credentials));
  // A new machine runs only its owner's jobs. Ask whether teammates' jobs may run here too,
  // but only when one of its workspaces has teammates. Reconnecting never asks again:
  // `relayrunner share`.
  let choice = share;
  if (!choice && hasTeammates(workspaces)) {
    if (process.stdin.isTTY && process.stdout.isTTY) choice = await askSharing(workspaces);
    else
      clack.log.info(
        "Only jobs you started run here. `relayrunner share anyone` lets teammates' jobs run here too.",
      );
  }
  if (choice) await applySharing(credentials, choice, workspaces);
  return credentials;
}

async function signIn(
  server: string,
  name: string,
  platform: { os: "linux" | "macos"; arch: "x64" | "arm64" },
) {
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

// `slotted`: name the slot a job runs in, when there's more than one.
function show(event: ConnectionEvent, slotted: boolean) {
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
      clack.log.step(
        `${at} Starting job ${event.routeId}${slotted ? ` in slot ${event.slot}` : ""}`,
      );
      break;
    case "paused":
      if (event.paused)
        clack.log.warn(
          `${at} Paused${event.by ? ` by ${event.by}` : ""}. Staying online, but new jobs skip this machine until it's resumed.${process.stdin.isTTY ? " Press p to resume." : ""}`,
        );
      else
        clack.log.success(`${at} Resumed${event.by ? ` by ${event.by}` : ""}. Waiting for jobs.`);
      break;
    case "token-not-saved":
      clack.log.warn(
        `${at} Couldn't save the machine's new token (${event.message}). Keeping the old one.`,
      );
      break;
    case "run-refused":
      clack.log.warn(
        `${at} Turned down job ${event.routeId}: already running ${event.running === 1 ? "one" : `${event.running}`}.`,
      );
      break;
    case "job": {
      const { routeId, state, message } = event.update;
      const slot = slotted ? ` (slot ${event.slot})` : "";
      const line = `${at} Job ${routeId}${slot} ${state}${message ? `: ${message}` : ""}`;
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
      "Show which machine this computer is signed in as and the workspaces it's in, checked with the gateway.",
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
          : "Not signed in. Run `relayrunner login` or `relayrunner connect` to sign in.",
        { status: "signed_out", server: server ?? null },
      );
      process.exitCode = 1;
      return;
    }

    const saved = { server: credentials.server, machine: credentials.machine };
    const result = await withCurrentToken(credentials, (token) =>
      whoami({ server: credentials.server, token }),
    );
    switch (result.status) {
      case "ok":
        print(
          describeIdentity(
            credentials.server,
            result.identity,
            !args.json && !readWorkspaces(result.identity).length
              ? await emptyWorkspacesNotice(credentials)
              : undefined,
          ),
          {
            status: "ok",
            server: credentials.server,
            ...result.identity,
          },
        );
        break;
      case "revoked":
        print(
          `${credentials.machine.name} was removed or its token is no longer valid.\nRun \`relayrunner connect\` to sign in again.`,
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

function describeIdentity(server: string, identity: WhoamiResponse, emptyNotice?: string) {
  const { machine, enrolledBy } = identity;
  const workspaces = readWorkspaces(identity);
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
  const details = table(`${machine.name} (${machine.id})`, [
    ["Workspaces", workspaces.length ? workspaceNames(workspaces) : "none"],
    ["Platform", [machine.os, machine.arch].filter(Boolean).join(" ") || "unknown"],
    ["Enrolled", enrolled],
    ["Status", status],
    ...(machine.sharing
      ? [
          ["Sharing", describeSharing(machine.sharing, sharingScope(workspaces))] as [
            string,
            string,
          ],
        ]
      : []),
    ["Gateway", server],
  ]);
  return emptyNotice ? `${details}\n\n${emptyNotice}` : details;
}

function describeSaved(saved: Pick<Credentials, "server" | "machine">) {
  return table(`${saved.machine.name} (${saved.machine.id})`, [["Gateway", saved.server]]);
}

function table(title: string, rows: [string, string][]) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return [title, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join("\n");
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
        console.error(
          "Not signed in. Run `relayrunner login` or `relayrunner connect` to sign in.",
        );
        process.exitCode = 1;
        return;
      }
      const result = await pauseMachine(credentials, paused);
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
            `${name} was removed or its token is no longer valid.\nRun \`relayrunner connect\` to sign in again.`,
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

// `relayrunner share [only-me|anyone]`: show or change who can run jobs on this machine, the
// same setting as the sharing icon on the machine's card on the Runners page.
const shareCommand = defineCommand({
  meta: {
    name: "share",
    description:
      "Show or change who can run jobs on this machine: only-me (jobs you started) or anyone in your workspaces.",
  },
  args: {
    who: {
      type: "positional",
      required: false,
      description: `${SHARE_CHOICES.join(" or ")}; leave out to show the current setting`,
    },
  },
  async run({ args }) {
    const credentials = readCredentials();
    if (!credentials) {
      console.error("Not signed in. Run `relayrunner login` or `relayrunner connect` to sign in.");
      process.exitCode = 1;
      return;
    }
    const { name } = credentials.machine;
    const revoked = () => {
      console.error(
        `${name} was removed or its token is no longer valid.\nRun \`relayrunner connect\` to sign in again.`,
      );
      process.exitCode = 1;
    };

    if (args.who) {
      const choice = parseShareChoice(args.who);
      if (!choice) {
        console.error(
          `Use \`relayrunner share ${SHARE_CHOICES.join("` or `relayrunner share ")}\`.`,
        );
        process.exitCode = 1;
        return;
      }
      const result = await withCurrentToken(credentials, (token) =>
        setSharing({ server: credentials.server, token, sharing: toSharing(choice) }),
      );
      if (result.status === "revoked") return revoked();
      if (result.status === "failed") {
        console.error(`Couldn't change sharing for ${name}: ${result.reason}.`);
        process.exitCode = 1;
        return;
      }
      console.log(`${name} now ${sharingMeaning(result.sharing)}.`);
      return;
    }

    const result = await withCurrentToken(credentials, (token) =>
      whoami({ server: credentials.server, token }),
    );
    if (result.status === "revoked") return revoked();
    if (result.status === "unverified") {
      console.error(`Couldn't check sharing for ${name}: ${result.reason}.`);
      process.exitCode = 1;
      return;
    }
    const { sharing } = result.identity.machine;
    if (!sharing) {
      console.error(`${credentials.server} doesn't support sharing yet.`);
      process.exitCode = 1;
      return;
    }
    const other = sharing === "only_me" ? "anyone" : "only-me";
    const workspaces = readWorkspaces(result.identity);
    const lines = [
      `${name} ${sharingMeaning(sharing, sharingScope(workspaces))} (${toChoice(sharing)}).`,
    ];
    if (!workspaces.length)
      lines.push(`${name} isn't in a workspace yet, so this matters once it is.`);
    else if (workspaces.every((workspace) => workspace.memberCount === 1))
      lines.push(
        `Nobody else is in ${sharingScope(workspaces)} yet, so this matters once a teammate joins.`,
      );
    lines.push(`Change it with \`relayrunner share ${other}\`.`);
    console.log(lines.join("\n"));
  },
});

const main = defineCommand({
  meta: {
    name: "relayrunner",
    version: cliVersion,
    description: "Run GitHub Actions jobs on your machine through the RelayRunner gateway.",
  },
  subCommands: {
    connect: connectCommand,
    login: loginCommand,
    whoami: whoamiCommand,
    init: initCommand,
    pause: pauseCommand(true),
    resume: pauseCommand(false),
    share: shareCommand,
    workspaces: workspacesCommand,
  },
});

void runMain(main);
