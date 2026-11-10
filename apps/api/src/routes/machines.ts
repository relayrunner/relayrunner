import { recordEvent } from "../activity.ts";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { APIError } from "better-auth/api";
import { HelloMessage } from "@relayrunner/machine-protocol";
import { MACHINE_SHARING } from "@relayrunner/activity";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { MACHINE_CLIENT_ID } from "../auth.ts";
import { createDb, schema } from "../db/index.ts";
import { isWorkspaceMember } from "../installations.ts";
import { runningJobs } from "../jobs.ts";
import { MACHINE_ID_HEADER, OFFLINE } from "../durable-objects/machine-session.ts";
import { addOrgRunnerLabels, type OrgRunner } from "../github-app.ts";
import {
  cannotAdd,
  describeAccess,
  isHiddenRunner,
  matchLabels,
  newRoutingLabel,
  readOrgRunners,
  runnerArch,
  runnerOs,
  type GroupAccess,
} from "../github-runners.ts";
import {
  generateMachineToken,
  normalizeUserCode,
  pausedByName,
  presentMachine,
  removeRoutingLabel,
  revokeMachines,
  setMachinePaused,
  setMachineSharing,
  sha256Hex,
  verifyMachineToken,
  type PauseVia,
} from "../machines.ts";
import type { Env } from "../env.ts";
import { sendEmail } from "../email.ts";
import { requireUser, waitUntil } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { canManage, canRevokeMachine, requireManager } from "../roles.ts";

// Enrolling a machine (`relayrunner connect`) with Better Auth's device authorization plugin:
//
// 1. The CLI asks for a code: POST /api/auth/device/code with client_id "relayrunner-cli". It
//    opens the returned verification_uri_complete (the dashboard's /device page), adding
//    &name=<hostname> as the default machine name, and polls /api/auth/device/token.
// 2. On /device the signed-in user picks a workspace and a name, and approves: POST /approve
//    below. That creates the machine (unclaimed, keyed by a hash of the device code) and approves
//    the code. Deny goes straight to /api/auth/device/deny.
// 3. The CLI's next poll returns a user session token. It calls POST /claim below with that
//    session as a bearer token plus the device code, gets the machine token back once, and the
//    session is revoked. From then on the machine authenticates as itself.
//
// A code approved but never claimed leaves an unclaimed row that nothing lists or accepts.
//
// Once enrolled, the CLI stays connected over GET /connect below, a WebSocket to the machine's
// MachineLink Durable Object speaking @relayrunner/machine-protocol.

const ApproveBody = z.object({
  userCode: z.string().min(1).max(64),
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(64),
});

const ClaimBody = z.object({
  deviceCode: z.string().min(1),
  os: HelloMessage.shape.os,
  arch: HelloMessage.shape.arch,
});

const DenyBody = z.object({ userCode: z.string().min(1).max(32) });

const SharingBody = z.object({ sharing: z.enum(MACHINE_SHARING) });

const AddRunnersBody = z.object({
  installationId: z.number().int().positive(),
  runnerIds: z.array(z.number().int().positive()).min(1).max(50),
});

export const machineRoutes = new Hono<AppEnv>()
  // The /device page's look at a code, without claiming it. Better Auth's own GET /device ties an
  // unclaimed code to whoever views it, so a link opened in a browser signed in as someone else
  // (the default browser, before a private window) would lock out the account that approves.
  // Approve and deny below claim the code instead, at the moment someone acts on it.
  .get("/device", requireUser, async (c) => {
    const userCode = normalizeUserCode(c.req.query("user_code") ?? "");
    const db = createDb(c.env.DB);
    const [code] = await db
      .select({
        status: schema.deviceCode.status,
        expiresAt: schema.deviceCode.expiresAt,
        clientId: schema.deviceCode.clientId,
      })
      .from(schema.deviceCode)
      .where(eq(schema.deviceCode.userCode, userCode))
      .limit(1);
    if (!code || code.clientId !== MACHINE_CLIENT_ID)
      return c.json({ error: "invalid_request" }, 400);
    if (code.expiresAt < new Date()) return c.json({ error: "expired_token" }, 400);
    return c.json({ user_code: userCode, status: code.status });
  })

  .post("/deny", requireUser, async (c) => {
    const parsed = DenyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const userCode = normalizeUserCode(parsed.data.userCode);
    try {
      // Claim it first (a no-op if this user already has), then deny.
      await c.var.auth.api.deviceVerify({
        query: { user_code: userCode },
        headers: c.req.raw.headers,
      });
      await c.var.auth.api.deviceDeny({ body: { userCode }, headers: c.req.raw.headers });
    } catch (error) {
      return deviceError(error);
    }
    return c.json({ success: true });
  })

  .post("/approve", requireUser, async (c) => {
    const parsed = ApproveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { workspaceId, name } = parsed.data;
    const userCode = normalizeUserCode(parsed.data.userCode);
    const user = c.var.user!;
    const db = createDb(c.env.DB);

    const membership = await isWorkspaceMember(db, workspaceId, user.id);
    // Any member can enroll a machine into the shared pool (#134).
    if (!membership) return c.json({ error: "forbidden" }, 403);

    // Opening the code ties it to this user (Better Auth only lets that user approve it). The
    // dashboard only looks at it through GET /device above, so this is where it gets claimed.
    try {
      await c.var.auth.api.deviceVerify({
        query: { user_code: userCode },
        headers: c.req.raw.headers,
      });
    } catch (error) {
      return deviceError(error);
    }

    const [code] = await db
      .select()
      .from(schema.deviceCode)
      .where(eq(schema.deviceCode.userCode, userCode))
      .limit(1);
    if (!code || code.expiresAt < new Date()) return c.json({ error: "expired_token" }, 400);
    if (code.clientId !== MACHINE_CLIENT_ID) return c.json({ error: "invalid_request" }, 400);
    if (code.status !== "pending") return c.json({ error: "already_processed" }, 409);
    if (code.userId !== user.id) return c.json({ error: "forbidden" }, 403);

    const machineId = crypto.randomUUID();
    await db.insert(schema.machine).values({
      id: machineId,
      workspaceId,
      name,
      enrollmentHash: await sha256Hex(code.deviceCode),
      createdBy: user.id,
    });

    try {
      await c.var.auth.api.deviceApprove({ body: { userCode }, headers: c.req.raw.headers });
    } catch (error) {
      await db.delete(schema.machine).where(eq(schema.machine.id, machineId));
      return deviceError(error);
    }
    return c.json({ machineId });
  })
  // Called by the CLI with the device-flow session as `Authorization: Bearer <token>`.
  .post("/claim", requireUser, async (c) => {
    const parsed = ClaimBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { deviceCode, os, arch } = parsed.data;
    const db = createDb(c.env.DB);

    const token = generateMachineToken();
    // The enrollment hash is cleared in the same statement, so a code claims at most once.
    const [machine] = await db
      .update(schema.machine)
      .set({ os, arch, tokenHash: await sha256Hex(token), enrollmentHash: null })
      .where(
        and(
          eq(schema.machine.enrollmentHash, await sha256Hex(deviceCode)),
          eq(schema.machine.createdBy, c.var.user!.id),
          isNull(schema.machine.revokedAt),
        ),
      )
      .returning();
    if (!machine) return c.json({ error: "not_found" }, 404);
    await recordEvent(db, {
      workspaceId: machine.workspaceId,
      type: "machine.enrolled",
      data: { machineName: machine.name, os: machine.os, arch: machine.arch },
      machineId: machine.id,
      actorUserId: c.var.user!.id,
    });

    // The CLI is done with the user session; only the machine token stays on the machine.
    await db.delete(schema.session).where(eq(schema.session.id, c.var.session!.id));

    const [workspace] = await db
      .select({ id: schema.workspace.id, name: schema.workspace.name, slug: schema.workspace.slug })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, machine.workspaceId))
      .limit(1);

    // Security notice to whoever approved the machine: its token can run the workspace's jobs.
    const notice = sendEmail(c.env, {
      to: c.var.user!.email,
      template: "machine-connected",
      context: {
        machineName: machine.name,
        os: machine.os,
        arch: machine.arch,
        workspaceName: workspace?.name ?? "your workspace",
        connectedAt: new Date(),
      },
    });
    const defer = waitUntil(c);
    if (defer) defer(notice);
    else await notice;
    return c.json({ machine: presentMachine(machine), workspace, token });
  })
  // The machine's WebSocket: `Upgrade: websocket` with `Authorization: Bearer rrm_…`. A missing,
  // unknown or revoked token gets a 401 before the upgrade. After that the machine sends `hello`,
  // then `status` as a heartbeat (src/durable-objects/machine-session.ts has the timings and
  // close codes). The token is checked first because a failed upgrade hides its status from the
  // CLI, so it asks with a plain GET: 401 means sign in again, 426 means the token is fine.
  .get("/connect", async (c) => {
    const token = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const machine = await verifyMachineToken(createDb(c.env.DB), token);
    if (!machine) return c.json({ error: "unauthorized" }, 401);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      return c.json({ error: "upgrade_required" }, 426);

    const headers = new Headers(c.req.raw.headers);
    headers.delete("authorization");
    headers.set(MACHINE_ID_HEADER, machine.id);
    return c.env.MACHINE_LINK.getByName(machine.id).fetch(new Request(c.req.raw, { headers }));
  })
  // Who a machine token belongs to, for `relayrunner whoami`: `Authorization: Bearer rrm_…`. A
  // missing, unknown or revoked token gets a 401, the same as /connect.
  .get("/me", async (c) => {
    const token = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const db = createDb(c.env.DB);
    const machine = await verifyMachineToken(db, token);
    if (!machine) return c.json({ error: "unauthorized" }, 401);

    const [[workspace], [enrolledBy], status] = await Promise.all([
      db
        .select({
          id: schema.workspace.id,
          name: schema.workspace.name,
          slug: schema.workspace.slug,
        })
        .from(schema.workspace)
        .where(eq(schema.workspace.id, machine.workspaceId))
        .limit(1),
      machine.createdBy
        ? db
            .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
            .from(schema.user)
            .where(eq(schema.user.id, machine.createdBy))
            .limit(1)
        : Promise.resolve([]),
      c.env.MACHINE_LINK.getByName(machine.id).status(),
    ]);
    return c.json({
      machine: { ...presentMachine(machine, await pausedByName(db, machine)), status },
      workspace,
      enrolledBy: enrolledBy ?? null,
    });
  })
  // Pausing from the machine itself, for `relayrunner pause` and `resume`: `Authorization: Bearer
  // rrm_…`, 401 like /me. Registered before /:id so "me" isn't read as a machine id.
  .post("/me/:action{pause|resume}", async (c) => {
    const token = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const db = createDb(c.env.DB);
    const machine = await verifyMachineToken(db, token);
    if (!machine) return c.json({ error: "unauthorized" }, 401);
    return pauseResponse(c.env, db, machine.id, c.req.param("action") === "pause", {
      userId: null,
      via: "cli",
    });
  })
  // Any member of the workspace may pause or resume any of its machines: the pool is shared, and
  // pausing is easy to undo. Activity records who did it.
  .post("/:id/:action{pause|resume}", requireUser, requireWorkspace, async (c) => {
    const [machine] = await c.var.db
      .select({ id: schema.machine.id })
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.id, c.req.param("id")),
          eq(schema.machine.workspaceId, c.var.workspace.id),
          isNotNull(schema.machine.os),
          isNull(schema.machine.revokedAt),
        ),
      )
      .limit(1);
    if (!machine) return c.json({ error: "not_found" }, 404);
    return pauseResponse(c.env, c.var.db, machine.id, c.req.param("action") === "pause", {
      userId: c.var.user!.id,
      via: "dashboard",
    });
  })
  // Whose jobs the machine takes (#242). Only its owner, the person who enrolled or added it, may
  // change it: it's their computer. Admins can still pause or revoke it.
  .put("/:id/sharing", requireUser, requireWorkspace, async (c) => {
    const body = SharingBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const [machine] = await c.var.db
      .select({ id: schema.machine.id, createdBy: schema.machine.createdBy })
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.id, c.req.param("id")),
          eq(schema.machine.workspaceId, c.var.workspace.id),
          isNull(schema.machine.revokedAt),
        ),
      )
      .limit(1);
    if (!machine) return c.json({ error: "not_found" }, 404);
    if (machine.createdBy !== c.var.user!.id) return c.json({ error: "not_owner" }, 403);
    const result = await setMachineSharing(c.var.db, machine.id, body.data.sharing, c.var.user!.id);
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json({
      machine: {
        ...presentMachine(result.machine, await pausedByName(c.var.db, result.machine)),
        status: await c.env.MACHINE_LINK.getByName(machine.id).status(),
      },
    });
  })
  .get("/", requireUser, requireWorkspace, async (c) => {
    const creator = alias(schema.user, "creator");
    const rows = await c.var.db
      .select({
        machine: schema.machine,
        pausedBy: schema.user.name,
        createdBy: creator.name,
        org: schema.githubInstallation.accountLogin,
      })
      .from(schema.machine)
      .leftJoin(schema.user, eq(schema.user.id, schema.machine.pausedBy))
      .leftJoin(creator, eq(creator.id, schema.machine.createdBy))
      .leftJoin(
        schema.githubInstallation,
        eq(schema.githubInstallation.id, schema.machine.installationId),
      )
      .where(
        and(
          eq(schema.machine.workspaceId, c.var.workspace.id),
          isNotNull(schema.machine.os),
          isNull(schema.machine.revokedAt),
        ),
      )
      .orderBy(asc(schema.machine.name));
    // Runners added from GitHub: each org's runner list for their live status, cached for a short
    // while in the workspace's Router so the page's refreshes don't each ask GitHub. Their group
    // access is read on demand (GET /:id/access) when a card's menu opens.
    const orgs = new Map<number, string>();
    for (const row of rows)
      if (row.machine.source === "github" && row.machine.installationId && row.org)
        orgs.set(row.machine.installationId, row.org);
    const router = orgs.size > 0 ? c.env.ROUTER.getByName(c.var.workspace.id) : null;
    const github = new Map(
      await Promise.all(
        [...orgs].map(async ([installationId, org]) => {
          const runners = await router!.githubRunners(installationId, org).catch(() => null);
          return [installationId, runners ? { runners } : null] as const;
        }),
      ),
    );
    // Live status from each connected machine's MachineLink. Fine for a handful per workspace.
    const statuses = await Promise.all(
      rows.map(async ({ machine }) => {
        if (machine.source !== "github") return c.env.MACHINE_LINK.getByName(machine.id).status();
        const read = machine.installationId ? github.get(machine.installationId) : null;
        const runner = read?.runners.find((r) => r.id === machine.githubRunnerId);
        return runner
          ? {
              online: runner.status === "online",
              state: runner.busy ? "busy" : "idle",
              connectedAt: null,
            }
          : OFFLINE;
      }),
    );
    // The job each busy machine is running, for its card.
    const jobs = await runningJobs(
      c.var.db,
      rows
        .filter((_, i) => statuses[i].online && statuses[i].state === "busy")
        .map((row) => row.machine.id),
    );
    return c.json({
      machines: rows.map((row, i) => {
        const presented = {
          ...presentMachine(row.machine, row.pausedBy),
          // Who connected it. A runner added from GitHub belongs to its org instead.
          owner: row.machine.source === "github" ? row.org : row.createdBy,
          job: jobs.get(row.machine.id) ?? null,
        };
        if (row.machine.source !== "github")
          return {
            ...presented,
            status: statuses[i],
            // Whether the signed-in user may revoke it (#134), so the dashboard can hide it.
            canRevoke: canRevokeMachine(c.var.role, c.var.user!.id, row.machine),
          };
        const read = row.machine.installationId ? github.get(row.machine.installationId) : null;
        const runner = read?.runners.find((r) => r.id === row.machine.githubRunnerId);
        return {
          ...presented,
          labels: runner ? matchLabels(runner.labels) : presented.labels,
          status: statuses[i],
          // Runners belong to the org: only owners and admins remove them.
          canRevoke: canManage(c.var.role),
          github: {
            org: row.org,
            runnerId: row.machine.githubRunnerId,
            // GitHub answered, and the runner isn't there: removed or re-registered.
            missing: Boolean(read) && !runner,
            // GitHub couldn't be asked; the status shown is offline.
            unreachable: !read,
          },
        };
      }),
    });
  })
  // Self-hosted runners already registered in the workspace's connected orgs, for adding them
  // (#159). Owners and admins only: the runners belong to the org. `?groups=false` reads only the
  // runner list (one GitHub call per org) for the Runners page's found card; the Add runner dialog
  // reads groups too, so it can show each runner's access and block workflow-only groups.
  .get("/github-runners", requireUser, requireWorkspace, requireManager, async (c) => {
    const groups = c.req.query("groups") !== "false";
    const installations = await c.var.db
      .select({ id: schema.githubInstallation.id, org: schema.githubInstallation.accountLogin })
      .from(schema.githubInstallation)
      .where(
        and(
          eq(schema.githubInstallation.workspaceId, c.var.workspace.id),
          eq(schema.githubInstallation.accountType, "Organization"),
          isNull(schema.githubInstallation.suspendedAt),
        ),
      )
      .orderBy(asc(schema.githubInstallation.accountLogin));
    const added = await c.var.db
      .select({
        id: schema.machine.id,
        installationId: schema.machine.installationId,
        githubRunnerId: schema.machine.githubRunnerId,
      })
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.workspaceId, c.var.workspace.id),
          eq(schema.machine.source, "github"),
          isNull(schema.machine.revokedAt),
        ),
      );
    // Without groups (the Runners page's found card) the runner list comes from the Router's
    // short cache, shared with GET /machines. The Add runner dialog reads fresh, with groups.
    const router = groups ? null : c.env.ROUTER.getByName(c.var.workspace.id);
    const orgs = await Promise.all(
      installations.map(async (installation) => {
        try {
          const { runners, access } = router
            ? {
                runners: await cachedRunners(router, installation.id, installation.org),
                access: new Map<number, GroupAccess>(),
              }
            : await readOrgRunners(c.env, installation.id, installation.org, { groups });
          return {
            installationId: installation.id,
            org: installation.org,
            runners: runners
              .filter((runner) => !isHiddenRunner(runner))
              .map((runner) => {
                const machine = added.find(
                  (m) => m.installationId === installation.id && m.githubRunnerId === runner.id,
                );
                return presentOrgRunner(runner, access.get(runner.id), machine?.id ?? null);
              }),
          };
        } catch (error) {
          console.warn(
            JSON.stringify({
              msg: "github runners unavailable",
              installationId: installation.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          return { installationId: installation.id, org: installation.org, error: "unavailable" };
        }
      }),
    );
    return c.json({ orgs });
  })
  // Adds org runners to the workspace: each gets RelayRunner's routing label on GitHub and a
  // machine row, and routes like a connected machine from then on. Nothing changes on the machine.
  .post("/github-runners", requireUser, requireWorkspace, requireManager, async (c) => {
    const parsed = AddRunnersBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { installationId, runnerIds } = parsed.data;
    const { db, workspace, user } = c.var;
    const [installation] = await db
      .select({ org: schema.githubInstallation.accountLogin })
      .from(schema.githubInstallation)
      .where(
        and(
          eq(schema.githubInstallation.id, installationId),
          eq(schema.githubInstallation.workspaceId, workspace.id),
          eq(schema.githubInstallation.accountType, "Organization"),
        ),
      )
      .limit(1);
    if (!installation) return c.json({ error: "not_found" }, 404);

    const { token, runners, access } = await readOrgRunners(
      c.env,
      installationId,
      installation.org,
    );
    const existing = await db
      .select({ githubRunnerId: schema.machine.githubRunnerId })
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.installationId, installationId),
          inArray(schema.machine.githubRunnerId, runnerIds),
          isNull(schema.machine.revokedAt),
        ),
      );
    const taken = new Set(existing.map((row) => row.githubRunnerId));
    const added = [];
    const skipped: { runnerId: number; reason: string }[] = [];
    for (const runnerId of new Set(runnerIds)) {
      const runner = runners.find((r) => r.id === runnerId);
      const reason = !runner
        ? "not_found"
        : taken.has(runnerId)
          ? "already_added"
          : cannotAdd(runner, access.get(runner.id));
      if (!runner || reason) {
        skipped.push({ runnerId, reason: reason ?? "not_found" });
        continue;
      }
      const routingLabel = newRoutingLabel();
      await addOrgRunnerLabels(token, installation.org, runner.id, [routingLabel]);
      const [machine] = await db
        .insert(schema.machine)
        .values({
          id: crypto.randomUUID(),
          workspaceId: workspace.id,
          name: runner.name,
          os: runnerOs(runner) ?? "linux",
          arch: runnerArch(runner),
          source: "github",
          installationId,
          githubRunnerId: runner.id,
          routingLabel,
          githubLabels: JSON.stringify([...runner.labels, routingLabel]),
          createdBy: user!.id,
          // The org's runner, usually shared team hardware: it takes anyone's jobs (#242).
          sharing: "anyone",
        })
        .returning();
      await recordEvent(db, {
        workspaceId: workspace.id,
        type: "machine.enrolled",
        data: { machineName: machine.name, os: machine.os, arch: machine.arch, source: "github" },
        machineId: machine.id,
        actorUserId: user!.id,
      });
      added.push(presentMachine(machine));
    }
    return c.json({ added, skipped });
  })
  // Which repos a runner added from GitHub may take jobs from, e.g. "Default group · all private
  // repos", for its card's menu. Read on demand: it takes several GitHub calls (the org's runner
  // groups, then each group's runners and repos), so the Runners page doesn't wait on it.
  .get("/:id/access", requireUser, requireWorkspace, async (c) => {
    const [row] = await c.var.db
      .select({ machine: schema.machine, org: schema.githubInstallation.accountLogin })
      .from(schema.machine)
      .leftJoin(
        schema.githubInstallation,
        eq(schema.githubInstallation.id, schema.machine.installationId),
      )
      .where(
        and(
          eq(schema.machine.id, c.req.param("id")),
          eq(schema.machine.workspaceId, c.var.workspace.id),
          isNull(schema.machine.revokedAt),
        ),
      );
    if (!row) return c.json({ error: "not_found" }, 404);
    const { machine, org } = row;
    if (machine.source !== "github" || !machine.installationId || !org || !machine.githubRunnerId)
      return c.json({ access: null });
    try {
      const { access } = await readOrgRunners(c.env, machine.installationId, org);
      return c.json({ access: describeAccess(access.get(machine.githubRunnerId)) });
    } catch {
      // GitHub couldn't be asked; the menu just leaves the line out.
      return c.json({ access: null });
    }
  })
  .delete("/:id", requireUser, requireWorkspace, async (c) => {
    const machineId = c.req.param("id");
    const { role, user, workspace, db } = c.var;
    const live = and(
      eq(schema.machine.id, machineId),
      eq(schema.machine.workspaceId, workspace.id),
      isNull(schema.machine.revokedAt),
    );
    // Owners and admins can revoke any machine; members only the ones they enrolled. The check
    // rides in the update so the common case is one query.
    // A runner added from GitHub belongs to the org, so only owners and admins remove it.
    const mine = and(
      live,
      eq(schema.machine.createdBy, user!.id),
      eq(schema.machine.source, "connect"),
    );
    const [machine] = await revokeMachines(c.env, db, (canManage(role) ? live : mine)!, user!.id);
    if (!machine) {
      // Nothing changed: tell a member a machine they can see apart from one that isn't there.
      const [exists] = await db
        .select({ id: schema.machine.id })
        .from(schema.machine)
        .where(live)
        .limit(1);
      return exists ? c.json({ error: "forbidden" }, 403) : c.json({ error: "not_found" }, 404);
    }
    if (machine.source === "github") await removeRoutingLabel(c.env, db, machine);
    return c.json({ machine: presentMachine(machine) });
  });

/** An org's runners from the Router's short cache; throws when GitHub couldn't be asked. */
async function cachedRunners(
  router: { githubRunners(installationId: number, org: string): Promise<OrgRunner[] | null> },
  installationId: number,
  org: string,
) {
  const runners = await router.githubRunners(installationId, org);
  if (!runners) throw new Error("GitHub runners unavailable");
  return runners;
}

/** What the add dialog shows of an org runner. */
function presentOrgRunner(
  runner: OrgRunner,
  access: GroupAccess | undefined,
  machineId: string | null,
) {
  return {
    id: runner.id,
    name: runner.name,
    os: runnerOs(runner),
    arch: runnerArch(runner),
    status: runner.status,
    busy: runner.busy,
    labels: matchLabels(runner.labels),
    access: describeAccess(access),
    // Why it can't be added ("workflows": its group only allows selected workflows), or null.
    blocked: cannotAdd(runner, access),
    // The machine it's already added as, or null.
    machineId,
  };
}

// Pauses or resumes the machine, tells its open connection, and answers with the machine.
async function pauseResponse(
  env: Env,
  db: ReturnType<typeof createDb>,
  machineId: string,
  paused: boolean,
  actor: { userId: string | null; via: PauseVia },
) {
  const result = await setMachinePaused(db, machineId, paused, actor);
  if (!result) return Response.json({ error: "not_found" }, { status: 404 });
  const by = await pausedByName(db, result.machine);
  const link = env.MACHINE_LINK.getByName(machineId);
  if (result.changed) await link.notifyPaused(paused, by);
  return Response.json({
    machine: { ...presentMachine(result.machine, by), status: await link.status() },
  });
}

// Better Auth's device errors carry an RFC 8628 code in the body; pass it through.
function deviceError(error: unknown) {
  if (error instanceof APIError) {
    const body = error.body as { error?: string } | undefined;
    return Response.json({ error: body?.error ?? "invalid_request" }, { status: error.statusCode });
  }
  throw error;
}
