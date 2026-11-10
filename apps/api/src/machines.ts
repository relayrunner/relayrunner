import { type SQL, and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { recordEvent } from "./activity.ts";
import type { Db } from "./db/index.ts";
import { schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { appInstallationToken, removeOrgRunnerLabel } from "./github-app.ts";
import { matchLabels, parseStoredLabels } from "./github-runners.ts";
import type { Device } from "@relayrunner/machine-protocol";
import type { MachineSharing } from "@relayrunner/activity";
import { machineLabels } from "./routing.ts";

// Machine tokens: what `relayrunner connect` holds after enrolling, and sends on the MachineLink
// WebSocket upgrade. Only their SHA-256 is stored, so a leaked database can't impersonate a
// machine. The prefix makes them easy to spot in logs and secret scanners.
export const MACHINE_TOKEN_PREFIX = "rrm_";

export function generateMachineToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return MACHINE_TOKEN_PREFIX + base64Url(bytes);
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The enrolled, unrevoked machine a token belongs to, or null. MachineLink (#66) calls this on the
 * WebSocket upgrade. A token the gateway sent to replace the current one (pendingTokenHash) works
 * too: the CLI only uses it once it has saved it, so using it finishes the rotation, and the old
 * token stops working. That covers a `token_saved` that never arrived.
 */
export async function verifyMachineToken(db: Db, token: string | null | undefined) {
  if (!token?.startsWith(MACHINE_TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const [machine] = await db
    .select()
    .from(schema.machine)
    .where(
      and(
        or(eq(schema.machine.tokenHash, hash), eq(schema.machine.pendingTokenHash, hash)),
        isNull(schema.machine.revokedAt),
      ),
    )
    .limit(1);
  if (!machine) return null;
  if (machine.pendingTokenHash !== hash) return machine;
  await promotePendingToken(db, machine.id, hash);
  return { ...machine, tokenHash: hash, pendingTokenHash: null };
}

/**
 * Starts rotating a machine's token: a new token whose hash is stored as pending, next to the
 * current one. Null when the machine was revoked meanwhile. The caller sends the token to the CLI.
 */
export async function issuePendingToken(db: Db, machineId: string) {
  const token = generateMachineToken();
  const hash = await sha256Hex(token);
  const [updated] = await db
    .update(schema.machine)
    .set({ pendingTokenHash: hash })
    .where(
      and(
        eq(schema.machine.id, machineId),
        isNull(schema.machine.revokedAt),
        isNotNull(schema.machine.tokenHash),
      ),
    )
    .returning({ id: schema.machine.id });
  return updated ? { token, hash } : null;
}

/**
 * Finishes a rotation: the pending token becomes the machine's token and the old one stops
 * working. Does nothing unless `pendingHash` is still the pending one, so a stale call can't undo
 * a newer rotation.
 */
export async function promotePendingToken(db: Db, machineId: string, pendingHash: string) {
  await db
    .update(schema.machine)
    .set({ tokenHash: pendingHash, pendingTokenHash: null })
    .where(
      and(
        eq(schema.machine.id, machineId),
        eq(schema.machine.pendingTokenHash, pendingHash),
        isNull(schema.machine.revokedAt),
      ),
    );
}

// Better Auth stores user codes without the dash the dashboard shows ("ABCD-EFGH" -> "ABCDEFGH").
export function normalizeUserCode(userCode: string) {
  return userCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * What the dashboard and the CLI see of a machine. Never includes the token hash. `pausedBy` is
 * the name of the user who paused it, when the caller looked it up.
 */
export function presentMachine(
  machine: typeof schema.machine.$inferSelect,
  pausedBy: string | null = null,
) {
  return {
    id: machine.id,
    name: machine.name,
    os: machine.os,
    arch: machine.arch,
    // The labels routing matches a job's `machine` input against, so the dashboard shows exactly
    // what matches. A GitHub runner's are its own GitHub labels, as last read.
    labels:
      machine.source === "github"
        ? matchLabels(parseStoredLabels(machine.githubLabels))
        : machineLabels(machine),
    // 'connect' (enrolled with the CLI) or 'github' (added from GitHub).
    source: machine.source === "github" ? ("github" as const) : ("connect" as const),
    // The label RelayRunner added to a GitHub runner to route jobs to it.
    routingLabel: machine.routingLabel,
    lastSeenAt: machine.lastSeenAt,
    revokedAt: machine.revokedAt,
    createdAt: machine.createdAt,
    // Null unless paused. `by` is null when the machine's own CLI paused it.
    paused: machine.pausedAt ? { at: machine.pausedAt, by: pausedBy } : null,
    // Whose jobs it takes ('only_me' or 'anyone'); only its owner (createdBy) can change it.
    sharing: machine.sharing,
    // What its CLI reported on its last hello, or null when it never did (an older CLI, or a
    // runner added from GitHub, which doesn't report hardware).
    device: machine.deviceKind
      ? {
          kind: machine.deviceKind,
          model: machine.deviceModel,
          modelId: machine.deviceModelId,
          chip: machine.chip,
          cpuCores: machine.cpuCores,
          memoryMb: machine.memoryMb,
          osVersion: machine.osVersion,
          reportedAt: machine.deviceReportedAt,
        }
      : null,
  };
}

/**
 * The machine columns a hello's device sets. Every column is written, so a part the CLI no
 * longer reports is cleared rather than left stale.
 */
export function deviceColumns(device: Device, now: Date) {
  return {
    deviceKind: device.kind,
    deviceModel: device.model ?? null,
    deviceModelId: device.modelId ?? null,
    chip: device.chip ?? null,
    cpuCores: device.cpuCores ?? null,
    memoryMb: device.memoryMb ?? null,
    osVersion: device.osVersion ?? null,
    deviceReportedAt: now,
  };
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Revokes every live machine `where` matches: the token stops working (its hash is dropped, so it
 * can never match again), each machine logs `machine.revoked` with the actor, and its open
 * MachineLink socket closes, ending any running job. Returns the machines it revoked.
 */
export async function revokeMachines(env: Env, db: Db, where: SQL, actorUserId: string | null) {
  const machines = await db
    .update(schema.machine)
    .set({ revokedAt: new Date(), tokenHash: null, pendingTokenHash: null, enrollmentHash: null })
    .where(and(where, isNull(schema.machine.revokedAt)))
    .returning();
  for (const machine of machines) {
    await recordEvent(db, {
      workspaceId: machine.workspaceId,
      type: "machine.revoked",
      data: {
        machineName: machine.name,
        ...(machine.source === "github" ? { source: "github" as const } : {}),
      },
      machineId: machine.id,
      actorUserId,
    });
  }
  // The tokens can't open a new socket any more; close the ones that are open.
  await Promise.all(machines.map((machine) => env.MACHINE_LINK.getByName(machine.id).revoke()));
  return machines;
}

export type PauseVia = "dashboard" | "cli";

/**
 * Pauses or resumes a machine and logs it in Activity. `userId` is who did it from the dashboard,
 * or null for the machine's own CLI. Doing what's already the case changes nothing and logs
 * nothing. Returns the machine as it is now, or null if it's gone or revoked.
 */
export async function setMachinePaused(
  db: Db,
  machineId: string,
  paused: boolean,
  actor: { userId: string | null; via: PauseVia },
) {
  const [machine] = await db
    .update(schema.machine)
    .set(
      paused
        ? { pausedAt: new Date(), pausedBy: actor.userId }
        : { pausedAt: null, pausedBy: null },
    )
    .where(
      and(
        eq(schema.machine.id, machineId),
        isNull(schema.machine.revokedAt),
        paused ? isNull(schema.machine.pausedAt) : isNotNull(schema.machine.pausedAt),
      ),
    )
    .returning();
  if (!machine) {
    const [current] = await db
      .select()
      .from(schema.machine)
      .where(and(eq(schema.machine.id, machineId), isNull(schema.machine.revokedAt)))
      .limit(1);
    return current ? { machine: current, changed: false } : null;
  }
  await recordEvent(db, {
    workspaceId: machine.workspaceId,
    type: paused ? "machine.paused" : "machine.resumed",
    data: { machineName: machine.name, via: actor.via },
    machineId: machine.id,
    actorUserId: actor.userId,
  });
  return { machine, changed: true };
}

/**
 * Sets whose jobs a machine takes and logs it in Activity, as its owner. Setting what's already the
 * case changes nothing and logs nothing.
 * Returns the machine as it is now, or null if it's gone or revoked.
 */
export async function setMachineSharing(
  db: Db,
  machineId: string,
  sharing: MachineSharing,
  ownerId: string,
) {
  const [current] = await db
    .select()
    .from(schema.machine)
    .where(and(eq(schema.machine.id, machineId), isNull(schema.machine.revokedAt)))
    .limit(1);
  if (!current) return null;
  if (current.sharing === sharing) return { machine: current, changed: false };
  const [machine] = await db
    .update(schema.machine)
    .set({ sharing })
    .where(eq(schema.machine.id, machineId))
    .returning();
  await recordEvent(db, {
    workspaceId: machine.workspaceId,
    type: "machine.sharing_changed",
    data: { machineName: machine.name, sharing },
    machineId: machine.id,
    actorUserId: ownerId,
  });
  return { machine, changed: true };
}

/** The name of the user who paused a machine, or null (not paused, or paused by its CLI). */
export async function pausedByName(db: Db, machine: typeof schema.machine.$inferSelect) {
  if (!machine.pausedAt || !machine.pausedBy) return null;
  const [user] = await db
    .select({ name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, machine.pausedBy))
    .limit(1);
  return user?.name ?? null;
}

// Takes RelayRunner's label off a removed GitHub runner, so jobs can't reach it through the label.
// Best effort: the machine row is already revoked, so routing never picks it again either way.
export async function removeRoutingLabel(
  env: Env,
  db: Db,
  machine: typeof schema.machine.$inferSelect,
) {
  if (!machine.installationId || !machine.githubRunnerId || !machine.routingLabel) return;
  try {
    const [installation] = await db
      .select({ org: schema.githubInstallation.accountLogin })
      .from(schema.githubInstallation)
      .where(eq(schema.githubInstallation.id, machine.installationId))
      .limit(1);
    if (!installation) return;
    const token = await appInstallationToken(env, machine.installationId);
    await removeOrgRunnerLabel(
      token,
      installation.org,
      machine.githubRunnerId,
      machine.routingLabel,
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "routing label not removed",
        machineId: machine.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
