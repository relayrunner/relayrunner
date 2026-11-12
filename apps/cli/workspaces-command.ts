// `relayrunner workspaces [list|add|remove]` (#366): which of its owner's workspaces this machine
// runs jobs in. The same choice as the "Run jobs in" checkboxes on /device.

import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { readCredentials, withCurrentToken, type Credentials } from "./credentials.ts";
import {
  anyoneWarning,
  describeMachineWorkspaces,
  labelWorkspace,
  machineWorkspaces,
  matchWorkspace,
  type WorkspaceChoice,
} from "./machine-workspaces.ts";
import { noWorkspaceYet, workspaceNames } from "./workspaces.ts";

function signedIn(): Credentials | null {
  const credentials = readCredentials();
  if (!credentials) {
    console.error("Not signed in. Run `relayrunner login` or `relayrunner connect` to sign in.");
    process.exitCode = 1;
  }
  return credentials;
}

function revoked(name: string) {
  console.error(
    `${name} was removed or its token is no longer valid.\nRun \`relayrunner connect\` to sign in again.`,
  );
  process.exitCode = 1;
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List your workspaces, showing which ones this machine runs jobs in.",
  },
  args: { json: { type: "boolean", description: "Print the result as JSON" } },
  async run({ args }) {
    const credentials = signedIn();
    if (!credentials) return;
    const result = await withCurrentToken(credentials, (token) =>
      machineWorkspaces({ server: credentials.server, token }),
    );
    if (result.status === "revoked") return revoked(credentials.machine.name);
    if (result.status !== "ok") {
      console.error(
        `Couldn't list workspaces for ${credentials.machine.name}: ${result.status === "failed" ? result.reason : "not found"}.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      args.json ? JSON.stringify(result.choice, null, 2) : describeMachineWorkspaces(result.choice),
    );
  },
});

function changeCommand(action: "add" | "remove") {
  const adding = action === "add";
  return defineCommand({
    meta: {
      name: action,
      description: adding
        ? "Run jobs from one more of your workspaces on this machine."
        : "Stop running jobs from one of your workspaces on this machine. It keeps running jobs in the others.",
    },
    args: {
      workspace: {
        type: "positional",
        required: false,
        description: "The workspace's name, slug or id; leave out to pick from a list",
      },
    },
    async run({ args }) {
      const credentials = signedIn();
      if (!credentials) return;
      const { server, machine } = credentials;
      const current = await withCurrentToken(credentials, (token) =>
        machineWorkspaces({ server, token }),
      );
      if (current.status === "revoked") return revoked(machine.name);
      if (current.status !== "ok") {
        console.error(
          `Couldn't ${action} a workspace for ${machine.name}: ${current.status === "failed" ? current.reason : "not found"}.`,
        );
        process.exitCode = 1;
        return;
      }
      const { workspaces, others } = current.choice;
      const candidates = adding ? others : workspaces;

      const picked = await pick(candidates, args.workspace, {
        action,
        machine: machine.name,
        // A name that's on the other side: already in it, or already not.
        elsewhere: adding ? workspaces : others,
        noWorkspaces: !workspaces.length && !others.length,
        server,
      });
      if (!picked) return;

      const result = await withCurrentToken(credentials, (token) =>
        machineWorkspaces({ server, token, change: { action, workspaceId: picked.id } }),
      );
      if (result.status === "revoked") return revoked(machine.name);
      if (result.status === "not_found") {
        console.error(`You're no longer a member of ${picked.name}.`);
        process.exitCode = 1;
        return;
      }
      if (result.status === "failed") {
        console.error(`Couldn't ${action} ${picked.name}: ${result.reason}.`);
        process.exitCode = 1;
        return;
      }
      const now = result.choice;
      if (adding) {
        console.log(`${machine.name} now runs jobs in ${workspaceNames(now.workspaces)}.`);
        if (now.machine.sharing === "anyone")
          console.warn(`Warning: ${anyoneWarning(machine.name, picked.name)}`);
      } else if (now.workspaces.length) {
        console.log(
          `${machine.name} no longer runs jobs in ${picked.name}. It still runs jobs in ${workspaceNames(now.workspaces)}.`,
        );
      } else {
        console.log(`${machine.name} no longer runs jobs in ${picked.name}.`);
        console.warn(
          `${machine.name} isn't in any workspace now, so it takes no jobs. Add one with \`relayrunner workspaces add <name>\`.`,
        );
      }
    },
  });
}

/** The workspace to add or remove: named on the command line, or picked from a list in a terminal. */
async function pick(
  candidates: WorkspaceChoice[],
  query: string | undefined,
  context: {
    action: "add" | "remove";
    machine: string;
    elsewhere: WorkspaceChoice[];
    noWorkspaces: boolean;
    server: string;
  },
): Promise<WorkspaceChoice | null> {
  const fail = (message: string) => {
    console.error(message);
    process.exitCode = 1;
    return null;
  };
  if (context.noWorkspaces) return fail(noWorkspaceYet(context.machine, context.server));
  const adding = context.action === "add";

  if (query) {
    const match = matchWorkspace(candidates, query);
    if (match.status === "one") return match.workspace;
    if (match.status === "several")
      return fail(
        [
          `More than one workspace is called ${JSON.stringify(query)}. Name it by id:`,
          ...match.workspaces.map((w) => `  ${labelWorkspace(w, true)}`),
        ].join("\n"),
      );
    const other = matchWorkspace(context.elsewhere, query);
    if (other.status !== "none") {
      // Nothing to change: report it without failing, like `share` with the current setting.
      const name = other.status === "one" ? other.workspace.name : query;
      console.log(
        adding
          ? `${context.machine} already runs jobs in ${name}.`
          : `${context.machine} doesn't run jobs in ${name}.`,
      );
      return null;
    }
    return fail(
      [
        `None of your workspaces is called ${JSON.stringify(query)}.`,
        ...(candidates.length
          ? [
              adding ? "Workspaces you can add:" : "Workspaces you can remove:",
              ...candidates.map((w) => `  ${labelWorkspace(w)}`),
            ]
          : []),
      ].join("\n"),
    );
  }

  if (!candidates.length) {
    console.log(
      adding
        ? `${context.machine} already runs jobs in all your workspaces.`
        : `${context.machine} isn't in any workspace.`,
    );
    return null;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return fail(`Name the workspace: \`relayrunner workspaces ${context.action} <name>\`.`);
  const choice = await clack.select<string>({
    message: adding
      ? `Which workspace should ${context.machine} run jobs in too?`
      : `Which workspace should ${context.machine} stop running jobs in?`,
    options: candidates.map((w) => ({
      value: w.id,
      label: w.name,
      ...(w.slug && w.slug !== w.name && { hint: w.slug }),
    })),
  });
  if (clack.isCancel(choice)) return null;
  return candidates.find((w) => w.id === choice) ?? null;
}

export const workspacesCommand = defineCommand({
  meta: {
    name: "workspaces",
    description:
      "Show or change which of your workspaces this machine runs jobs in: `list` (the default), `add <name>`, `remove <name>`.",
  },
  default: "list",
  subCommands: {
    list: listCommand,
    add: changeCommand("add"),
    remove: changeCommand("remove"),
  },
});

/**
 * Why a machine has no workspaces, for `connect` and `whoami`: its owner has none yet (install
 * RelayRunner), or the machine just isn't in any of theirs (`relayrunner workspaces add`).
 */
export async function emptyWorkspacesNotice(credentials: Credentials) {
  const { server, machine } = credentials;
  const result = await withCurrentToken(credentials, (token) =>
    machineWorkspaces({ server, token }),
  );
  if (result.status === "ok" && result.choice.others.length)
    return `${machine.name} isn't in any of your workspaces, so it takes no jobs. Add one with \`relayrunner workspaces add <name>\` (${workspaceNames(result.choice.others)}).`;
  return noWorkspaceYet(machine.name, server);
}
