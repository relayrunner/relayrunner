import { ApiError, api } from "@/lib/api";
import { authDisabled } from "@/lib/auth-client";
import type { MachineDevice } from "./device.ts";

/**
 * A machine jobs can route to (GET /api/machines): enrolled with `relayrunner connect`, or a
 * self-hosted runner added from GitHub.
 */
export type Machine = {
  id: string;
  name: string;
  os: "linux" | "macos" | "windows" | null;
  arch: "x64" | "arm64" | "arm" | null;
  /**
   * The runner labels a job's `machine:` input matches against, in GitHub's spellings, such as
   * `["self-hosted", "macOS", "ARM64"]`. Missing from an API that predates them.
   */
  labels?: string[];
  // The labels of its VM, when it also runs jobs in one (`connect --isolated --macos`).
  isolatedLabels?: string[];
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /**
   * Set while paused: jobs skip the machine, but it stays connected. `by` is who paused it, or
   * null when its own CLI did. Missing from an API that predates pausing.
   */
  paused?: { at: string; by: string | null } | null;
  /** Whether the signed-in user may revoke it. Missing from an API that predates roles. */
  canRevoke?: boolean;
  /** "github" for a runner added from GitHub. Missing from an API that predates them. */
  source?: "connect" | "github";
  /** The label RelayRunner added to a GitHub runner to route jobs to it. */
  routingLabel?: string | null;
  /** A GitHub runner's org and whether GitHub still has it. Its group access: machineAccess. */
  github?: {
    org: string | null;
    runnerId: number | null;
    /** GitHub answered and the runner wasn't there: removed or re-registered. */
    missing: boolean;
    /** GitHub couldn't be asked, so the status reads offline. */
    unreachable: boolean;
  };
  /**
   * What the machine's CLI reported on its last hello: the kind of device and its specs. Null
   * when it never did (an older CLI, or a runner added from GitHub). Missing from an API that
   * predates it.
   */
  device?: MachineDevice | null;
  /** The size of each job's VM, from its last hello. Null when it doesn't run jobs in VMs. */
  vm?: { cpus: number; memoryGb: number } | null;
  /**
   * The relayrunner CLI version from its last hello, and the newer release to update to, or null
   * when up to date. Null for a runner added from GitHub or a CLI older than 0.7.0. Missing from an
   * API that predates it.
   */
  cli?: { version: string; update: string | null } | null;
  /**
   * Who connected it, or the org a runner added from GitHub belongs to. Missing from an API that
   * predates it.
   */
  owner?: string | null;
  /** The owner's GitHub avatar URL, or the org's for a runner added from GitHub. */
  ownerImage?: string | null;
  /** Whether the signed-in user owns it, so only they change its sharing. */
  mine?: boolean;
  /**
   * Whose jobs it takes: only its owner's, or any job routed to it. Missing from an API that
   * predates it, which read as "anyone".
   */
  sharing?: MachineSharing;
  /** The newest job it's running, while it reports itself busy. Missing from an API that predates it. */
  job?: MachineJob | null;
  /**
   * Every job it's running, newest first, up to `status.running` (#179). Missing from an API that
   * predates concurrency.
   */
  jobs?: MachineJob[];
  /** Live, from the machine's connection (or GitHub, for a GitHub runner). */
  status?: {
    online: boolean;
    state: "idle" | "busy" | null;
    /** Epoch ms of the current connection. */
    connectedAt: number | null;
    /**
     * How many jobs it runs at once, and how many it reports running (#179). Missing from an API
     * that predates concurrency: read as 1 slot, with busy as 1 running. Offline reads 1 slot,
     * since the gateway doesn't keep the count once a machine disconnects (#346).
     */
    slots?: number;
    running?: number;
  };
};

export type MachineJob = {
  repository: string;
  workflow: string | null;
  name: string;
  url: string;
  startedAt: string | null;
};

export type MachineSharing = "only_me" | "anyone";

/** Sets whose jobs a machine takes. Only its owner may. */
export function setMachineSharing(id: string, sharing: MachineSharing) {
  return api<{ machine: Machine }>(`/machines/${encodeURIComponent(id)}/sharing`, {
    method: "PUT",
    body: JSON.stringify({ sharing }),
  });
}

/** The signed-in user's own connected machines, with no workspace needed (GET /api/machines/mine). */
export function listMyMachines() {
  return api<{ machines: Machine[] }>("/machines/mine");
}

/**
 * One of the signed-in user's own machines that isn't in this workspace, so they can add it.
 * `workspaces` names where it does run jobs.
 */
export type OtherMachine = Pick<Machine, "id" | "name" | "os" | "arch" | "device"> & {
  online: boolean;
  sharing: "only_me" | "anyone";
  workspaces: string[];
};

export function listMachines() {
  return api<{ machines: Machine[]; others?: OtherMachine[] }>("/machines");
}

// The workspace's machines, shared by every runner hover card and kept for a short while, so
// hovering down a table reads the list once.
const FRESH_MS = 30_000;
let machines: { at: number; list: Promise<Machine[]>; read?: Machine[] } | null = null;

/** A machine from the last read, or undefined when there's no fresh one to go by. */
export function cachedMachine(id: string) {
  if (!machines?.read || Date.now() - machines.at > FRESH_MS) return undefined;
  return machines.read.find((machine) => machine.id === id) ?? null;
}

/** One machine of the workspace's, or null when it isn't one of them. */
export async function workspaceMachine(id: string) {
  if (!machines || Date.now() - machines.at > FRESH_MS) {
    const list = authDisabled
      ? Promise.resolve([SAMPLE_MACHINE])
      : listMachines().then((result) => result.machines);
    // A failed read isn't kept, so the next hover asks again.
    list.catch(() => {
      if (machines?.list === list) machines = null;
    });
    const entry: NonNullable<typeof machines> = { at: Date.now(), list };
    void list.then(
      (read) => (entry.read = read),
      () => undefined,
    );
    machines = entry;
  }
  return (await machines.list).find((machine) => machine.id === id) ?? null;
}

// The dev preview's machine, matching the sample reports' `machine:sample`.
const SAMPLE_MACHINE: Machine = {
  id: "sample",
  name: "zach-mbp",
  os: "linux",
  arch: "arm64",
  lastSeenAt: null,
  revokedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  source: "connect",
  device: {
    kind: "laptop",
    model: "MacBook Pro",
    modelId: "Mac15,9",
    chip: "Apple M3 Max",
    cpuCores: 16,
    memoryMb: 49_152,
    osVersion: "macOS 26.1",
    reportedAt: null,
  },
  vm: { cpus: 4, memoryGb: 8 },
  cli: { version: "0.9.0", update: null },
  owner: "Zach",
  mine: true,
  sharing: "anyone",
  status: {
    online: true,
    state: "idle",
    connectedAt: Date.now() - 2 * 3_600_000,
    slots: 2,
    running: 0,
  },
};

/** Adds the user's own machines to the current workspace, so they take its jobs. */
export function addMachinesToWorkspace(machineIds: string[]) {
  return api<{ added: number }>("/machines/workspace", {
    method: "POST",
    body: JSON.stringify({ machineIds }),
  });
}

/**
 * Which repos a runner added from GitHub may take jobs from, e.g. "Default group · all private
 * repos", or null when unknown. Read on demand: it takes several GitHub calls.
 */
export async function machineAccess(machineId: string) {
  const { access } = await api<{ access: string | null }>(
    `/machines/${encodeURIComponent(machineId)}/access`,
  );
  return access;
}

/** A self-hosted runner registered in a connected org (GET /api/machines/github-runners). */
export type OrgRunner = {
  id: number;
  name: string;
  os: Machine["os"];
  arch: Machine["arch"];
  status: "online" | "offline";
  busy: boolean;
  labels: string[];
  /** "Default group · all private repos", or null when unknown. */
  access: string | null;
  /** Why it can't be added: "workflows" when its group only allows selected workflows. */
  blocked: "workflows" | "own" | "ephemeral" | null;
  /** The machine it's already added as. */
  machineId: string | null;
};

export type OrgRunners =
  | { installationId: number; org: string; runners: OrgRunner[] }
  | { installationId: number; org: string; error: string };

/** The connected orgs' self-hosted runners, for adding them. Owners and admins only. */
/**
 * Runners in the workspace's connected orgs. `groups: false` skips GitHub's runner-group lookups:
 * one call per org instead of several, but a runner in a workflow-only group isn't marked blocked.
 */
export function listGithubRunners({ groups = true }: { groups?: boolean } = {}) {
  return api<{ orgs: OrgRunners[] }>(
    groups ? "/machines/github-runners" : "/machines/github-runners?groups=false",
  );
}

/** Adds org runners: RelayRunner labels each on GitHub and routes jobs to it from then on. */
export function addGithubRunners(installationId: number, runnerIds: number[]) {
  return api<{ added: Machine[]; skipped: { runnerId: number; reason: string }[] }>(
    "/machines/github-runners",
    { method: "POST", body: JSON.stringify({ installationId, runnerIds }) },
  );
}

/** Runners in connected orgs that could be added and aren't yet. */
export function addableRunners(orgs: OrgRunners[]) {
  return orgs.flatMap((org) =>
    "runners" in org ? org.runners.filter((r) => !r.machineId && !r.blocked) : [],
  );
}

/** "just now", "5 minutes ago", "3 days ago". */
export function timeAgo(date: string | number, now = Date.now()) {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000);
  if (seconds > -45) return "just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(-1, "minute");
}

/** Pauses the machine: it stays connected, but jobs skip it until it's resumed. */
export function pauseMachine(id: string) {
  return api<{ machine: Machine }>(`/machines/${encodeURIComponent(id)}/pause`, {
    method: "POST",
  });
}

/** Lets jobs route to a paused machine again. */
export function resumeMachine(id: string) {
  return api<{ machine: Machine }>(`/machines/${encodeURIComponent(id)}/resume`, {
    method: "POST",
  });
}

/** Revokes the machine's token. Its CLI has to run `relayrunner connect` again. */
export function revokeMachine(id: string) {
  return api<{ machine: Machine }>(`/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Takes one of the user's own machines out of this workspace; it keeps its other workspaces. */
export function removeMachineFromWorkspace(id: string) {
  return api<{ removed: string }>(`/machines/${encodeURIComponent(id)}/workspace`, {
    method: "DELETE",
  });
}

/** GET /api/auth/device: a device code's state. Opening it also ties it to the signed-in user. */
export type DeviceCodeStatus = {
  user_code: string;
  status: "pending" | "approved" | "denied";
  // When `relayrunner connect` asked for the code, and roughly where from (an ISO country code and
  // a city, either missing when Cloudflare couldn't tell). `differentCountry` is true when that's
  // a different country from the browser looking at it, null when either side is unknown.
  requested_at?: string;
  // Where the machine could take jobs. `joined`: one the user only joined through GitHub (#364).
  workspaces?: { id: string; name: string; slug: string; joined: boolean }[];
  requested_from?: {
    country: string | null;
    city: string | null;
    differentCountry: boolean | null;
  } | null;
};

/**
 * Looks up a `relayrunner connect` code without claiming it: the code belongs to whoever approves
 * or denies it, not whoever first opens the link (which may be another browser's account).
 */
export function openDeviceCode(userCode: string) {
  return api<DeviceCodeStatus>(`/machines/device?user_code=${encodeURIComponent(userCode)}`);
}

/** `workspaceIds`: where the machine takes jobs; left out, the API picks the ones they installed. */
export function approveDevice(body: { userCode: string; name: string; workspaceIds?: string[] }) {
  return api<{ machineId: string }>("/machines/approve", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function denyDevice(userCode: string) {
  return api<{ success: boolean }>("/machines/deny", {
    method: "POST",
    body: JSON.stringify({ userCode }),
  });
}

/** "ABCDEFGH" -> "ABCD-EFGH", the way the CLI prints it. */
export function formatUserCode(userCode: string) {
  const code = userCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** What a device-flow error code means for the person at the approval page. */
export function describeDeviceError(error: unknown) {
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case "invalid_request":
      return "That code doesn't match a sign-in request. Check it against your terminal.";
    case "expired_token":
      return "That code has expired. Run `relayrunner connect` again for a new one.";
    case "already_processed":
    case "device_code_already_processed":
      return "That code has already been used.";
    case "forbidden":
    case "access_denied":
      return "Another account already approved or denied this request, or you aren't in that workspace. Run `relayrunner connect` again for a new code.";
    default:
      return "Something went wrong. Try again.";
  }
}
