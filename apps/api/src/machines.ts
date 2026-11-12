import { type SQL, and, count, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { type NewActivityEvent, recordEvent } from "./activity.ts";
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
  // A newer rotation may have replaced this pending token since the read: then it's no good.
  if (await promotePendingToken(db, machine.id, hash))
    return { ...machine, tokenHash: hash, pendingTokenHash: null };
  const [now] = await db
    .select()
    .from(schema.machine)
    .where(and(eq(schema.machine.id, machine.id), isNull(schema.machine.revokedAt)))
    .limit(1);
  return now?.tokenHash === hash ? now : null;
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
 * a newer rotation. Returns whether it promoted.
 */
export async function promotePendingToken(db: Db, machineId: string, pendingHash: string) {
  const promoted = await db
    .update(schema.machine)
    .set({ tokenHash: pendingHash, pendingTokenHash: null })
    .where(
      and(
        eq(schema.machine.id, machineId),
        eq(schema.machine.pendingTokenHash, pendingHash),
        isNull(schema.machine.revokedAt),
      ),
    )
    .returning({ id: schema.machine.id });
  return promoted.length > 0;
}

// Better Auth stores user codes without the dash the dashboard shows ("ABCD-EFGH" -> "ABCDEFGH").
export function normalizeUserCode(userCode: string) {
  return userCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

type Machine = typeof schema.machine.$inferSelect;

/**
 * Which machines a workspace has: the connected machines their owners put in it (machine_workspace,
 * #363) while the owner is still a member, plus the GitHub runners adopted from its own
 * installation. Routing, Runners and Activity all read machines through this.
 */
export function inWorkspace(db: Db, workspaceId: string): SQL {
  return or(
    eq(schema.machine.workspaceId, workspaceId),
    and(
      eq(schema.machine.source, "connect"),
      inArray(
        schema.machine.id,
        db
          .select({ machineId: schema.machineWorkspace.machineId })
          .from(schema.machineWorkspace)
          .where(eq(schema.machineWorkspace.workspaceId, workspaceId)),
      ),
      // A backstop: membership sync deletes the rows of a workspace the owner leaves, and a row
      // left behind still never routes.
      inArray(
        schema.machine.userId,
        db
          .select({ userId: schema.workspaceMember.userId })
          .from(schema.workspaceMember)
          .where(eq(schema.workspaceMember.workspaceId, workspaceId)),
      ),
    ),
  )!;
}

/**
 * The workspaces a user is a member of, oldest membership first. `joined` is true for one they only
 * joined through GitHub, false for one they installed or their personal account's (the owner rule
 * in memberships.ts), so /device can start the owned ones ticked (#364).
 */
export async function userWorkspaces(db: Db, userId: string) {
  const rows = await db
    .select({
      id: schema.workspace.id,
      name: schema.workspace.name,
      slug: schema.workspace.slug,
      role: schema.workspaceMember.role,
    })
    .from(schema.workspaceMember)
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.workspaceMember.workspaceId))
    .where(eq(schema.workspaceMember.userId, userId))
    .orderBy(schema.workspaceMember.createdAt, schema.workspace.id);
  return rows.map(({ role, ...workspace }) => ({ ...workspace, joined: role !== "owner" }));
}

/**
 * The connected machine's workspaces (machine_workspace) that its owner is still a member of, oldest
 * membership first.
 */
async function connectedMachineWorkspaces(
  db: Db,
  machine: Pick<Machine, "id" | "userId">,
): Promise<Awaited<ReturnType<typeof userWorkspaces>>> {
  if (!machine.userId) return [];
  const [mine, rows] = await Promise.all([
    userWorkspaces(db, machine.userId),
    db
      .select({ workspaceId: schema.machineWorkspace.workspaceId })
      .from(schema.machineWorkspace)
      .where(eq(schema.machineWorkspace.machineId, machine.id)),
  ]);
  const listed = new Set(rows.map((row) => row.workspaceId));
  return mine.filter((workspace) => listed.has(workspace.id));
}

/**
 * What the CLI is told about where its machine is: the workspaces it takes jobs in, each with its
 * member count, and the single `workspace` CLI 0.5.0 reads. That one is the workspace with the
 * most members, so 0.5.0's "ask about sharing when someone else is there" (#244) still asks when
 * any of them has teammates. Null when the machine is in no workspace.
 */
export async function presentMachineWorkspaces(db: Db, machine: Pick<Machine, "id" | "userId">) {
  const listed = await connectedMachineWorkspaces(db, machine);
  const counts = listed.length
    ? await db
        .select({ workspaceId: schema.workspaceMember.workspaceId, members: count() })
        .from(schema.workspaceMember)
        .where(
          inArray(
            schema.workspaceMember.workspaceId,
            listed.map((workspace) => workspace.id),
          ),
        )
        .groupBy(schema.workspaceMember.workspaceId)
    : [];
  const workspaces = listed.map(({ joined: _joined, ...workspace }) => ({
    ...workspace,
    memberCount: counts.find((row) => row.workspaceId === workspace.id)?.members ?? 0,
  }));
  const workspace = workspaces.reduce<(typeof workspaces)[number] | null>(
    (best, next) => (!best || next.memberCount > best.memberCount ? next : best),
    null,
  );
  return { workspace, workspaces };
}

/**
 * The workspaces a machine is in right now: an adopted runner's one workspace, or the ones a
 * connected machine's owner put it in.
 */
export async function machineWorkspaceIds(
  db: Db,
  machine: Pick<Machine, "id" | "workspaceId" | "userId">,
): Promise<string[]> {
  if (machine.workspaceId) return [machine.workspaceId];
  return (await connectedMachineWorkspaces(db, machine)).map((workspace) => workspace.id);
}

/**
 * Puts the owner's machines in a workspace (#363). Only machines `userId` owns, and only a
 * workspace they're a member of; the caller checks membership. Logs machine.workspace_added in
 * that workspace for each machine that wasn't there yet, and returns those machines' ids.
 */
export async function addMachinesToWorkspace(
  db: Db,
  {
    userId,
    workspaceId,
    machineIds,
  }: { userId: string; workspaceId: string; machineIds: string[] },
) {
  if (machineIds.length === 0) return [];
  const owned = await db
    .select({ id: schema.machine.id, name: schema.machine.name })
    .from(schema.machine)
    .where(
      and(
        inArray(schema.machine.id, machineIds),
        eq(schema.machine.userId, userId),
        eq(schema.machine.source, "connect"),
        isNull(schema.machine.revokedAt),
      ),
    );
  if (owned.length === 0) return [];
  const inserted = await db
    .insert(schema.machineWorkspace)
    .values(owned.map((machine) => ({ machineId: machine.id, workspaceId })))
    .onConflictDoNothing()
    .returning({ machineId: schema.machineWorkspace.machineId });
  for (const { machineId } of inserted) {
    const machine = owned.find((m) => m.id === machineId)!;
    await recordEvent(db, {
      workspaceId,
      type: "machine.workspace_added",
      data: { machineName: machine.name },
      machineId,
      actorUserId: userId,
    });
  }
  return inserted.map((row) => row.machineId);
}

/**
 * Puts the user's machines that are in no workspace at all into `workspaceId`, a workspace they
 * now own. That's a machine approved before they had a workspace (an org install waiting on its
 * owners, #322), which would otherwise take no jobs until they added it by hand.
 */
export async function addHomelessMachines(db: Db, userId: string, workspaceId: string) {
  const homeless = await db
    .select({ id: schema.machine.id })
    .from(schema.machine)
    .leftJoin(schema.machineWorkspace, eq(schema.machineWorkspace.machineId, schema.machine.id))
    .where(
      and(
        eq(schema.machine.userId, userId),
        eq(schema.machine.source, "connect"),
        isNull(schema.machine.revokedAt),
        isNull(schema.machineWorkspace.machineId),
      ),
    );
  return addMachinesToWorkspace(db, {
    userId,
    workspaceId,
    machineIds: homeless.map((machine) => machine.id),
  });
}

/** Takes all of the user's machines out of a workspace they're no longer a member of. */
export async function removeUserMachinesFromWorkspace(db: Db, userId: string, workspaceId: string) {
  await db
    .delete(schema.machineWorkspace)
    .where(
      and(
        eq(schema.machineWorkspace.workspaceId, workspaceId),
        inArray(
          schema.machineWorkspace.machineId,
          db
            .select({ id: schema.machine.id })
            .from(schema.machine)
            .where(eq(schema.machine.userId, userId)),
        ),
      ),
    );
}

/**
 * Takes one of the owner's machines out of a workspace. Logs machine.workspace_removed there when
 * it was in it. Returns whether it was.
 */
export async function removeMachineFromWorkspace(
  db: Db,
  machine: Pick<Machine, "id" | "name">,
  workspaceId: string,
  actorUserId: string,
) {
  const deleted = await db
    .delete(schema.machineWorkspace)
    .where(
      and(
        eq(schema.machineWorkspace.machineId, machine.id),
        eq(schema.machineWorkspace.workspaceId, workspaceId),
      ),
    )
    .returning({ machineId: schema.machineWorkspace.machineId });
  if (deleted.length === 0) return false;
  await recordEvent(db, {
    workspaceId,
    type: "machine.workspace_removed",
    data: { machineName: machine.name },
    machineId: machine.id,
    actorUserId,
  });
  return true;
}

/**
 * The owner's connected machines that aren't in `workspaceId`, for the Runners page's "Your other
 * machines" (#365), each with the names of the workspaces it is in.
 */
export async function otherMachines(db: Db, userId: string, workspaceId: string) {
  const [machines, mine, rows] = await Promise.all([
    db
      .select()
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.userId, userId),
          eq(schema.machine.source, "connect"),
          isNotNull(schema.machine.os),
          isNull(schema.machine.revokedAt),
        ),
      )
      .orderBy(schema.machine.name),
    userWorkspaces(db, userId),
    db
      .select({
        machineId: schema.machineWorkspace.machineId,
        workspaceId: schema.machineWorkspace.workspaceId,
      })
      .from(schema.machineWorkspace)
      .innerJoin(schema.machine, eq(schema.machine.id, schema.machineWorkspace.machineId))
      .where(eq(schema.machine.userId, userId)),
  ]);
  return machines.flatMap((machine) => {
    const ids = rows.filter((row) => row.machineId === machine.id).map((row) => row.workspaceId);
    if (ids.includes(workspaceId)) return [];
    return [
      {
        machine,
        // In membership order, and only the ones the owner is still in.
        workspaces: mine.filter((w) => ids.includes(w.id)).map((w) => w.name),
      },
    ];
  });
}

/**
 * Logs a machine event in every workspace the machine is in at the time, so each one's Activity
 * shows it.
 */
export async function recordMachineEvents(
  db: Db,
  machine: Pick<Machine, "id" | "workspaceId" | "userId">,
  event: DistributiveOmit<NewActivityEvent, "workspaceId">,
) {
  for (const workspaceId of await machineWorkspaceIds(db, machine))
    await recordEvent(db, { ...event, workspaceId } as NewActivityEvent);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What the dashboard and the CLI see of a machine. Never includes the token hash. `pausedBy` is
 * the name of the user who paused it, when the caller looked it up.
 */
export function presentMachine(machine: Machine, pausedBy: string | null = null) {
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
    // Whose jobs it takes ('only_me' or 'anyone'); only its owner (userId) can change it.
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
    await recordMachineEvents(db, machine, {
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
  await recordMachineEvents(db, machine, {
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
  await recordMachineEvents(db, machine, {
    type: "machine.sharing_changed",
    data: { machineName: machine.name, sharing },
    machineId: machine.id,
    actorUserId: ownerId,
  });
  return { machine, changed: true };
}

/** The name of the user who paused a machine, or null (not paused, or paused by its CLI). */
export async function pausedByName(db: Db, machine: Machine) {
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
export async function removeRoutingLabel(env: Env, db: Db, machine: Machine) {
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
