import { ApiError, api } from "@/lib/api";
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
  /** The job it's running, while it reports itself busy. Missing from an API that predates it. */
  job?: {
    repository: string;
    workflow: string | null;
    name: string;
    url: string;
    startedAt: string | null;
  } | null;
  /** Live, from the machine's connection (or GitHub, for a GitHub runner). */
  status?: {
    online: boolean;
    state: "idle" | "busy" | null;
    /** Epoch ms of the current connection. */
    connectedAt: number | null;
  };
};

export type MachineSharing = "only_me" | "anyone";

/** Sets whose jobs a machine takes. Only its owner may. */
export function setMachineSharing(id: string, sharing: MachineSharing) {
  return api<{ machine: Machine }>(`/machines/${encodeURIComponent(id)}/sharing`, {
    method: "PUT",
    body: JSON.stringify({ sharing }),
  });
}

export function listMachines() {
  return api<{ machines: Machine[] }>("/machines");
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

/** GET /api/auth/device: a device code's state. Opening it also ties it to the signed-in user. */
export type DeviceCodeStatus = {
  user_code: string;
  status: "pending" | "approved" | "denied";
  // When `relayrunner connect` asked for the code, and roughly where from (an ISO country code and
  // a city, either missing when Cloudflare couldn't tell). `differentCountry` is true when that's
  // a different country from the browser looking at it, null when either side is unknown.
  requested_at?: string;
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

export function approveDevice(body: { userCode: string; workspaceId: string; name: string }) {
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
