import { recordEvent } from "../activity.ts";
import { and, asc, eq, gt, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { APIError } from "better-auth/api";
import { HelloMessage } from "@relayrunner/machine-protocol";
import { MACHINE_SHARING } from "@relayrunner/activity";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { MACHINE_CLIENT_ID } from "../auth.ts";
import { createDb, type Db, schema } from "../db/index.ts";
import { presentOrigin, requestOrigin } from "../device-origin.ts";
import { runningJobs } from "../jobs.ts";
import { claimRunnerJobs } from "../job-timings.ts";
import {
  MACHINE_ID_HEADER,
  MACHINE_ORIGIN_HEADER,
  OFFLINE,
} from "../durable-objects/machine-session.ts";
import { addRunnerLabels, type GitHubRunner, type RunnerScope } from "../github-app.ts";
import {
  addedRunnerScope,
  cannotAdd,
  describeAccess,
  describeRepoAccess,
  runnerListKey,
  isHiddenRunner,
  matchLabels,
  newRoutingLabel,
  readRunners,
  runnerArch,
  runnerOs,
  type GroupAccess,
} from "../github-runners.ts";
import { MAX_RUNNER_REPOS, privateRepos } from "../repositories.ts";
import { loadRunnerReleases } from "../runner-releases.ts";
import {
  addedMachineScope,
  addMachinesToWorkspace,
  generateMachineToken,
  inWorkspace,
  normalizeUserCode,
  otherMachines,
  pausedByName,
  presentMachine,
  presentRunner,
  presentMachineWorkspaces,
  recordMachineEvents,
  removeMachineFromWorkspace,
  removeRoutingLabel,
  revokeMachines,
  setMachinePaused,
  setMachineSharing,
  sha256Hex,
  userWorkspaces,
  verifyMachineToken,
  type PauseVia,
} from "../machines.ts";
import type { Env } from "../env.ts";
import { sendEmail } from "../email.ts";
import { inBackground, requireUser } from "../middleware/session.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { canControlMachine, requireManager } from "../roles.ts";
import { AppError, type ErrorCode } from "@relayrunner/errors";
import { annotate } from "../tracing.ts";
import { machineJobFailure } from "../job-failures.ts";
import {
  MAX_MACHINE_JOBS,
  machineJob,
  machineJobs,
  machineJobSteps,
  machineWorkspaceFor,
} from "../machine-jobs.ts";

// Enrolling a machine (`relayrunner connect`) with Better Auth's device authorization plugin:
//
// 1. The CLI asks for a code: POST /api/auth/device/code with client_id "relayrunner-cli". It
//    opens the returned verification_uri_complete (the dashboard's /device page), adding
//    &name=<hostname> as the default machine name, and polls /api/auth/device/token.
// 2. On /device the signed-in user picks a name and the workspaces it takes jobs in, and approves:
//    POST /approve below. That creates the machine (unclaimed, keyed by a hash of the device code),
//    owned by them (#318), with a machine_workspace row for each workspace picked (#363). Deny
//    goes straight to /api/auth/device/deny.
// 3. The CLI's next poll returns a user session token. It calls POST /claim below with that
//    session as a bearer token plus the device code, gets the machine token back once, and the
//    session is revoked. From then on the machine authenticates as itself.
//
// A code approved but never claimed leaves an unclaimed row that nothing lists or accepts.
//
// Once enrolled, the CLI stays connected over GET /connect below, a WebSocket to the machine's
// MachineLink Durable Object speaking @relayrunner/machine-protocol.

const JobId = z.coerce.number().int().positive();
const JobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_MACHINE_JOBS).optional(),
  before: z.coerce.number().int().positive().optional(),
  repo: z.string().min(1).max(200).optional(),
  workflow: z.string().min(1).max(200).optional(),
  result: z.enum(["succeeded", "failed", "canceled"]).optional(),
  since: z.coerce.number().int().positive().optional(),
});

const ApproveBody = z.object({
  userCode: z.string().min(1).max(64),
  // Ignored: a machine belongs to its user, not a workspace (#318). Still accepted from
  // dashboards that send it.
  workspaceId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(64),
  // The workspaces it takes jobs in (#363), each one the user is a member of. At least one when
  // they have any. Left out (dashboards from before #364), it's the workspaces they own: the ones
  // they installed and their personal account's, never one they only joined.
  workspaceIds: z.array(z.string().min(1)).max(100).optional(),
});

const AddToWorkspaceBody = z.object({
  machineIds: z.array(z.string().min(1)).min(1).max(50),
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
  // The repo the runners are registered on; left out for org runners.
  repositoryId: z.number().int().positive().optional(),
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
        createdAt: schema.deviceCode.createdAt,
        requestCountry: schema.deviceCode.requestCountry,
        requestCity: schema.deviceCode.requestCity,
      })
      .from(schema.deviceCode)
      .where(eq(schema.deviceCode.userCode, userCode))
      .limit(1);
    if (!code || code.clientId !== MACHINE_CLIENT_ID) throw new AppError("DEVICE_CODE_INVALID");
    if (code.expiresAt < new Date()) throw new AppError("DEVICE_CODE_EXPIRED");
    return c.json({
      user_code: userCode,
      status: code.status,
      // Where the machine could take jobs (#364). `joined`: a workspace the user only joined
      // through GitHub, which /device starts unticked.
      workspaces: await userWorkspaces(db, c.var.user!.id),
      // When and where `relayrunner connect` asked for this code, so the approver can tell
      // whether it was them.
      requested_at: code.createdAt,
      requested_from: presentOrigin(
        { country: code.requestCountry, city: code.requestCity },
        requestOrigin(c.req.raw),
      ),
    });
  })

  .post("/deny", requireUser, async (c) => {
    const parsed = DenyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const userCode = normalizeUserCode(parsed.data.userCode);
    try {
      // Claim it first (a no-op if this user already has), then deny.
      await c.var.auth.api.deviceVerify({
        query: { user_code: userCode },
        headers: c.req.raw.headers,
      });
      await c.var.auth.api.deviceDeny({ body: { userCode }, headers: c.req.raw.headers });
    } catch (error) {
      throw deviceError(error);
    }
    return c.json({ success: true });
  })

  .post("/approve", requireUser, async (c) => {
    const parsed = ApproveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const { name } = parsed.data;
    const userCode = normalizeUserCode(parsed.data.userCode);
    const user = c.var.user!;
    const db = createDb(c.env.DB);

    // Opening the code ties it to this user (Better Auth only lets that user approve it). The
    // dashboard only looks at it through GET /device above, so this is where it gets claimed.
    try {
      await c.var.auth.api.deviceVerify({
        query: { user_code: userCode },
        headers: c.req.raw.headers,
      });
    } catch (error) {
      throw deviceError(error);
    }

    const [code] = await db
      .select()
      .from(schema.deviceCode)
      .where(eq(schema.deviceCode.userCode, userCode))
      .limit(1);
    if (!code || code.expiresAt < new Date()) throw new AppError("DEVICE_CODE_EXPIRED");
    if (code.clientId !== MACHINE_CLIENT_ID) throw new AppError("DEVICE_CODE_INVALID");
    if (code.status !== "pending") throw new AppError("DEVICE_CODE_USED");
    if (code.userId !== user.id) throw new AppError("DEVICE_CODE_CLAIMED");

    const mine = await userWorkspaces(db, user.id);
    const picked = parsed.data.workspaceIds
      ? [...new Set(parsed.data.workspaceIds)]
      : mine.filter((workspace) => !workspace.joined).map((workspace) => workspace.id);
    if (picked.some((id) => !mine.some((workspace) => workspace.id === id)))
      throw new AppError("NOT_A_MEMBER");
    if (parsed.data.workspaceIds && picked.length === 0 && mine.length > 0)
      throw new AppError("INVALID_REQUEST", { message: "Choose at least one workspace." });

    const machineId = crypto.randomUUID();
    await db.insert(schema.machine).values({
      id: machineId,
      name,
      enrollmentHash: await sha256Hex(code.deviceCode),
      userId: user.id,
    });
    if (picked.length > 0)
      await db
        .insert(schema.machineWorkspace)
        .values(picked.map((workspaceId) => ({ machineId, workspaceId })));

    try {
      await c.var.auth.api.deviceApprove({ body: { userCode }, headers: c.req.raw.headers });
    } catch (error) {
      await db.delete(schema.machine).where(eq(schema.machine.id, machineId));
      throw deviceError(error);
    }
    return c.json({ machineId });
  })
  // Called by the CLI with the device-flow session as `Authorization: Bearer <token>`.
  .post("/claim", requireUser, async (c) => {
    const parsed = ClaimBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
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
          eq(schema.machine.userId, c.var.user!.id),
          isNull(schema.machine.revokedAt),
        ),
      )
      .returning();
    if (!machine) throw new AppError("NOT_FOUND");
    await recordMachineEvents(db, machine, {
      type: "machine.enrolled",
      data: { machineName: machine.name, os: machine.os, arch: machine.arch },
      machineId: machine.id,
      actorUserId: c.var.user!.id,
    });

    // The CLI is done with the user session; only the machine token stays on the machine.
    await db.delete(schema.session).where(eq(schema.session.id, c.var.session!.id));

    const { workspace, workspaces } = await presentMachineWorkspaces(db, machine);

    // Notice to whoever approved the machine: its token can run their workspaces' jobs. They can
    // turn it off in Account settings.
    const notice = sendEmail(c.env, {
      to: c.var.user!.email,
      userId: c.var.user!.id,
      template: "machine-connected",
      context: {
        machineName: machine.name,
        os: machine.os,
        arch: machine.arch,
        workspaceNames: workspaces.map((w) => w.name),
        connectedAt: new Date(),
      },
    });
    await inBackground(c, notice);
    // memberCount tells the CLI whether to ask who can run jobs here (#244): alone in every
    // workspace, there's nobody else's jobs to take. `workspace` is for CLI 0.5.0, which reads
    // only that one; `workspaces` is every workspace the machine is now in.
    return c.json({
      machine: presentMachine(machine),
      workspace,
      workspaces,
      token,
    });
  })
  // The machine's WebSocket: `Upgrade: websocket` with `Authorization: Bearer rrm_…`. A missing,
  // unknown or revoked token gets a 401 before the upgrade. After that the machine sends `hello`,
  // then `status` as a heartbeat (src/durable-objects/machine-session.ts has the timings and
  // close codes). The token is checked first because a failed upgrade hides its status from the
  // CLI, so it asks with a plain GET: 401 means sign in again, 426 means the token is fine.
  .get("/connect", async (c) => {
    const machine = await machineFromToken(createDb(c.env.DB), c.req.header("authorization"));
    if (!machine) throw new AppError("UNAUTHENTICATED");
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      throw new AppError("WEBSOCKET_REQUIRED");

    const headers = new Headers(c.req.raw.headers);
    headers.delete("authorization");
    headers.set(MACHINE_ID_HEADER, machine.id);
    // Where the connection came from, so MachineLink can tell the owner when a connection from
    // somewhere else takes over (request.cf doesn't reach a Durable Object).
    headers.set(MACHINE_ORIGIN_HEADER, JSON.stringify(requestOrigin(c.req.raw)));
    return c.env.MACHINE_LINK.getByName(machine.id).fetch(new Request(c.req.raw, { headers }));
  })
  // Who a machine token belongs to, for `relayrunner whoami`: `Authorization: Bearer rrm_…`. A
  // missing, unknown or revoked token gets a 401, the same as /connect.
  .get("/me", async (c) => {
    const token = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const db = createDb(c.env.DB);
    const machine = await verifyMachineToken(db, token);
    if (!machine) throw new AppError("UNAUTHENTICATED");

    const [{ workspace, workspaces }, [enrolledBy], status] = await Promise.all([
      presentMachineWorkspaces(db, machine),
      machine.userId
        ? db
            .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
            .from(schema.user)
            .where(eq(schema.user.id, machine.userId))
            .limit(1)
        : Promise.resolve([]),
      c.env.MACHINE_LINK.getByName(machine.id).status(),
    ]);
    return c.json({
      machine: { ...presentMachine(machine, await pausedByName(db, machine)), status },
      // As in the claim: one workspace for CLI 0.5.0, and the full list.
      workspace,
      workspaces,
      enrolledBy: enrolledBy ?? null,
    });
  })
  // Sharing from the machine itself, for `relayrunner share` and `connect --share` (#244):
  // `Authorization: Bearer rrm_…`, 401 like /me. Only an owner may change sharing, and the token
  // lives on the owner's computer, so the change is logged as theirs.
  .put("/me/sharing", async (c) => {
    const token = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const db = createDb(c.env.DB);
    const machine = await verifyMachineToken(db, token);
    if (!machine) throw new AppError("UNAUTHENTICATED");
    const body = SharingBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new AppError("INVALID_REQUEST");
    if (!machine.userId) throw new AppError("MACHINE_NOT_OWNED");
    const result = await setMachineSharing(db, machine.id, body.data.sharing, machine.userId);
    if (!result) throw new AppError("NOT_FOUND");
    return c.json({
      machine: {
        ...presentMachine(result.machine, await pausedByName(db, result.machine)),
        status: await c.env.MACHINE_LINK.getByName(machine.id).status(),
      },
    });
  })
  // The jobs this machine ran, for RelayRunner for Mac: `Authorization: Bearer rrm_…`, 401 like
  // /me. Newest first; `before` (ms, from `next`) continues. A machine sees only its own jobs.
  .get("/me/jobs", async (c) => {
    const db = createDb(c.env.DB);
    const machine = await machineFromToken(db, c.req.header("authorization"));
    if (!machine) throw new AppError("UNAUTHENTICATED");
    const query = JobsQuery.safeParse(c.req.query());
    if (!query.success) throw new AppError("INVALID_REQUEST");
    return c.json(await machineJobs(db, machine.id, query.data));
  })
  // One of them with its steps from GitHub (null when GitHub no longer has the job). 404 when the
  // job didn't run on this machine.
  .get("/me/jobs/:jobId", async (c) => {
    const db = createDb(c.env.DB);
    const machine = await machineFromToken(db, c.req.header("authorization"));
    if (!machine) throw new AppError("UNAUTHENTICATED");
    const jobId = JobId.safeParse(c.req.param("jobId"));
    if (!jobId.success) throw new AppError("INVALID_REQUEST");
    const found = await machineJob(db, machine.id, jobId.data);
    if (!found) throw new AppError("NOT_FOUND");
    const steps = await machineJobSteps(c.env, found.job, found.installationId);
    return c.json({ job: found.job, steps });
  })
  // Why one of them failed: the failed step, annotations, a log excerpt and, when the workspace has
  // AI on, the likely cause. 404 when it didn't run here or didn't fail.
  .get("/me/jobs/:jobId/failure", async (c) => {
    const db = createDb(c.env.DB);
    const machine = await machineFromToken(db, c.req.header("authorization"));
    if (!machine) throw new AppError("UNAUTHENTICATED");
    const jobId = JobId.safeParse(c.req.param("jobId"));
    if (!jobId.success) throw new AppError("INVALID_REQUEST");
    const found = await machineJob(db, machine.id, jobId.data);
    if (!found) throw new AppError("NOT_FOUND");
    const workspaceId = await machineWorkspaceFor(db, machine, found.installationId);
    const failure = await machineJobFailure(db, c.env, machine.id, jobId.data, workspaceId);
    if (!failure) throw new AppError("NOT_FOUND");
    return c.json(failure);
  })
  // The machine's workspaces, for `relayrunner workspaces` (#366): `Authorization: Bearer rrm_…`,
  // 401 like /me. `workspaces` are the ones it takes jobs in, `others` its owner's other ones.
  .get("/me/workspaces", async (c) => {
    const db = createDb(c.env.DB);
    const machine = await machineFromToken(db, c.req.header("authorization"));
    if (!machine) throw new AppError("UNAUTHENTICATED");
    return c.json(await presentWorkspaceChoice(db, machine));
  })
  // Adds the machine to, or takes it out of, one of its owner's workspaces. The token lives on the
  // owner's computer, so the change is logged as theirs.
  .on(["PUT", "DELETE"], "/me/workspaces/:workspaceId", async (c) => {
    const db = createDb(c.env.DB);
    const machine = await machineFromToken(db, c.req.header("authorization"));
    if (!machine) throw new AppError("UNAUTHENTICATED");
    if (!machine.userId) throw new AppError("MACHINE_NOT_OWNED");
    const workspaceId = c.req.param("workspaceId");
    const mine = await userWorkspaces(db, machine.userId);
    if (!mine.some((workspace) => workspace.id === workspaceId)) throw new AppError("NOT_FOUND");
    if (c.req.method === "PUT")
      await addMachinesToWorkspace(db, {
        userId: machine.userId,
        workspaceId,
        machineIds: [machine.id],
      });
    else await removeMachineFromWorkspace(db, machine, workspaceId, machine.userId);
    return c.json(await presentWorkspaceChoice(db, machine));
  })
  // Pausing from the machine itself, for `relayrunner pause` and `resume`: `Authorization: Bearer
  // rrm_…`, 401 like /me. Registered before /:id so "me" isn't read as a machine id.
  .post("/me/:action{pause|resume}", async (c) => {
    const token = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const db = createDb(c.env.DB);
    const machine = await verifyMachineToken(db, token);
    if (!machine) throw new AppError("UNAUTHENTICATED");
    return pauseResponse(c.env, db, machine.id, c.req.param("action") === "pause", {
      userId: null,
      via: "cli",
    });
  })
  // Only a connected machine's owner pauses or resumes it, from any workspace it shows up in; a
  // runner added from GitHub, by the workspace's owners and admins (#318). Pausing is global:
  // every workspace stops routing to it.
  .post("/:id/:action{pause|resume}", requireUser, requireWorkspace, async (c) => {
    const [machine] = await c.var.db
      .select({
        id: schema.machine.id,
        source: schema.machine.source,
        userId: schema.machine.userId,
      })
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.id, c.req.param("id")),
          inWorkspace(c.var.db, c.var.workspace.id),
          isNotNull(schema.machine.os),
          isNull(schema.machine.revokedAt),
        ),
      )
      .limit(1);
    if (!machine) throw new AppError("NOT_FOUND");
    if (!canControlMachine(c.var.role, c.var.user!.id, machine)) throw new AppError("FORBIDDEN");
    return pauseResponse(c.env, c.var.db, machine.id, c.req.param("action") === "pause", {
      userId: c.var.user!.id,
      via: "dashboard",
    });
  })
  // Whose jobs the machine takes (#242), in every workspace it's in. Only its owner, the person who
  // enrolled it, may change it: it's their computer.
  .put("/:id/sharing", requireUser, requireWorkspace, async (c) => {
    const body = SharingBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new AppError("INVALID_REQUEST");
    const [machine] = await c.var.db
      .select({ id: schema.machine.id, userId: schema.machine.userId })
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.id, c.req.param("id")),
          inWorkspace(c.var.db, c.var.workspace.id),
          isNull(schema.machine.revokedAt),
        ),
      )
      .limit(1);
    if (!machine) throw new AppError("NOT_FOUND");
    if (machine.userId !== c.var.user!.id) throw new AppError("MACHINE_NOT_OWNED");
    const result = await setMachineSharing(c.var.db, machine.id, body.data.sharing, c.var.user!.id);
    if (!result) throw new AppError("NOT_FOUND");
    return c.json({
      machine: {
        ...presentMachine(result.machine, await pausedByName(c.var.db, result.machine)),
        status: await c.env.MACHINE_LINK.getByName(machine.id).status(),
      },
    });
  })
  // The signed-in user's own connected machines, with no workspace needed: the dashboard's "no
  // workspace yet" page lists them while an install is pending (#320). Agent tokens are granted
  // workspaces, not a user's machines, so they don't reach this.
  .get("/mine", requireUser, async (c) => {
    if (c.var.agent) throw new AppError("NOT_FOUND");
    const db = createDb(c.env.DB);
    const rows = await db
      .select()
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.userId, c.var.user!.id),
          eq(schema.machine.source, "connect"),
          isNotNull(schema.machine.os),
          isNull(schema.machine.revokedAt),
        ),
      )
      .orderBy(asc(schema.machine.name));
    const [statuses, releases] = await Promise.all([
      Promise.all(rows.map((machine) => c.env.MACHINE_LINK.getByName(machine.id).status())),
      loadRunnerReleases(c.var.db),
    ]);
    return c.json({
      machines: rows.map((machine, i) => ({
        ...presentMachine(machine),
        runner: presentRunner(machine, releases),
        status: statuses[i],
      })),
    });
  })
  .get("/", requireUser, requireWorkspace, async (c) => {
    // Read alongside everything below; nothing here depends on it.
    const loadingReleases = loadRunnerReleases(c.var.db);
    const creator = alias(schema.user, "owner");
    const rows = await c.var.db
      .select({
        machine: schema.machine,
        pausedBy: schema.user.name,
        ownerName: creator.name,
        ownerImage: creator.image,
        org: schema.githubInstallation.accountLogin,
        repo: schema.githubRepository.fullName,
      })
      .from(schema.machine)
      .leftJoin(schema.user, eq(schema.user.id, schema.machine.pausedBy))
      .leftJoin(creator, eq(creator.id, schema.machine.userId))
      .leftJoin(
        schema.githubInstallation,
        eq(schema.githubInstallation.id, schema.machine.installationId),
      )
      .leftJoin(
        schema.githubRepository,
        eq(schema.githubRepository.id, schema.machine.githubRepositoryId),
      )
      .where(
        and(
          // Its members' connected machines and its own adopted runners (#318).
          inWorkspace(c.var.db, c.var.workspace.id),
          isNotNull(schema.machine.os),
          isNull(schema.machine.revokedAt),
        ),
      )
      .orderBy(asc(schema.machine.name));
    // Runners added from GitHub: the runner list of each org (or repo, for a repo runner) for their
    // live status, cached for a short while in the workspace's Router so the page's refreshes
    // don't each ask GitHub. Their group access is read on demand (GET /:id/access) when a card's
    // menu opens.
    // Agents (agent-auth.ts) skip this: their reads stay off the Router, which picks jobs, so those
    // runners come back with github.unreachable.
    // Each row's runner list key, and the distinct lists to read.
    const reads = new Map<string, { installationId: number; scope: RunnerScope }>();
    const keys = rows.map(({ machine, org, repo }) => {
      const scope =
        !c.var.agent && machine.source === "github" && machine.installationId && org
          ? addedRunnerScope(machine, org, repo)
          : null;
      if (!scope) return null;
      const key = runnerListKey(machine.installationId!, scope);
      reads.set(key, { installationId: machine.installationId!, scope });
      return key;
    });
    const router = reads.size > 0 ? c.env.ROUTER.getByName(c.var.workspace.id) : null;
    const github = new Map(
      await Promise.all(
        [...reads].map(async ([key, { installationId, scope }]) => {
          const read = await router!.githubRunners(installationId, scope).catch(() => null);
          return [key, read] as const;
        }),
      ),
    );
    const readOf = (i: number) => (keys[i] ? github.get(keys[i]) : null);
    // Live status from each connected machine's MachineLink. Fine for a handful per workspace.
    const statuses = await Promise.all(
      rows.map(async ({ machine }, i) => {
        if (machine.source !== "github") return c.env.MACHINE_LINK.getByName(machine.id).status();
        const runner = readOf(i)?.runners.find((r) => r.id === machine.githubRunnerId);
        // One runner runs one job.
        return runner
          ? {
              online: runner.status === "online",
              state: runner.busy ? "busy" : "idle",
              connectedAt: null,
              slots: 1,
              running: runner.busy ? 1 : 0,
            }
          : OFFLINE;
      }),
    );
    // The jobs each busy machine is running, for its card. Someone else's machine shows only this
    // workspace's jobs: the rest belong to other GitHub accounts its owner is in, and the card
    // just reads "Running a job". The owner sees all of theirs.
    const jobs = await runningJobs(
      c.var.db,
      rows.flatMap((row, i) =>
        statuses[i].online && statuses[i].state === "busy"
          ? [
              {
                id: row.machine.id,
                running: Math.max(1, statuses[i].running),
                ...(row.machine.userId === c.var.user!.id
                  ? {}
                  : { installationId: c.var.workspace.installationId ?? null }),
              },
            ]
          : [],
      ),
    );
    // The signed-in user's own machines that don't take jobs here (#365). Only they see theirs.
    // Agents read the workspace, not a user's machines, so they don't get these.
    const others = c.var.agent
      ? []
      : await otherMachines(c.var.db, c.var.user!.id, c.var.workspace.id);
    const otherStatuses = await Promise.all(
      others.map(({ machine }) => c.env.MACHINE_LINK.getByName(machine.id).status()),
    );
    const releases = await loadingReleases;
    return c.json({
      others: others.map(({ machine, workspaces }, i) => ({
        id: machine.id,
        name: machine.name,
        os: machine.os,
        arch: machine.arch,
        device: presentMachine(machine).device,
        online: otherStatuses[i].online,
        sharing: machine.sharing,
        workspaces,
      })),
      machines: rows.map((row, i) => {
        const presented = {
          ...presentMachine(row.machine, row.pausedBy),
          runner: presentRunner(row.machine, releases),
          // Who connected it. A runner added from GitHub belongs to its org instead.
          owner: row.machine.source === "github" ? row.org : row.ownerName,
          // The owner's GitHub avatar, or the org's for a runner added from GitHub.
          ownerImage:
            row.machine.source === "github"
              ? row.org
                ? `https://github.com/${encodeURIComponent(row.org)}.png?size=64`
                : null
              : row.ownerImage,
          // Whether the signed-in user owns it: only the owner changes its sharing (#243).
          mine: row.machine.userId === c.var.user!.id,
          // Every job it's running, newest first (#179), and the newest alone as before.
          jobs: jobs.get(row.machine.id) ?? [],
          job: jobs.get(row.machine.id)?.[0] ?? null,
        };
        if (row.machine.source !== "github")
          return {
            ...presented,
            status: statuses[i],
            // Whether the signed-in user may pause or revoke it: only its owner (#318), so the
            // dashboard can hide it.
            canRevoke: canControlMachine(c.var.role, c.var.user!.id, row.machine),
          };
        const read = readOf(i);
        const runner = read?.runners.find((r) => r.id === row.machine.githubRunnerId);
        return {
          ...presented,
          labels: runner ? matchLabels(runner.labels) : presented.labels,
          status: statuses[i],
          // Runners belong to the org: only owners and admins remove them.
          canRevoke: canControlMachine(c.var.role, c.var.user!.id, row.machine),
          github: {
            org: row.org,
            // owner/name for a runner registered on a repo, null for an org runner.
            repo: row.repo,
            runnerId: row.machine.githubRunnerId,
            // GitHub answered, and the runner isn't there: removed or re-registered.
            missing: Boolean(read) && !runner,
            // GitHub couldn't be asked; the status shown is offline.
            unreachable: !read,
            // When GitHub was last asked for its status (epoch ms), or null when it couldn't be.
            checkedAt: read?.checkedAt ?? null,
          },
        };
      }),
    });
  })
  // Self-hosted runners already registered in the workspace's connected account, in its org
  // (#159) or on its private repos (#162), for adding them. Owners and admins only: the runners
  // belong to the account. `?groups=false` skips the org's runner groups for the Runners page's
  // found card, and reads the org list from the Router's short cache; the Add runner dialog reads
  // groups too, so it can show each runner's access and block workflow-only groups. Repo runners
  // take one GitHub call per private repo, through the Router's cache, for the first
  // MAX_RUNNER_REPOS (`moreRepos` says there are more). `?repo=name` (or owner/name) looks in that
  // one repo instead, for an account with more private repos than that.
  .get("/github-runners", requireUser, requireWorkspace, requireManager, async (c) => {
    const groups = c.req.query("groups") !== "false";
    const lookup = c.req.query("repo")?.trim() || null;
    // `?fresh=true` (the dialog's Rescan, and a lookup by name) skips the cached repo scan.
    const fresh = lookup !== null || c.req.query("fresh") === "true";
    const installations = await c.var.db
      .select({
        id: schema.githubInstallation.id,
        org: schema.githubInstallation.accountLogin,
        accountType: schema.githubInstallation.accountType,
      })
      .from(schema.githubInstallation)
      .where(
        and(
          eq(schema.githubInstallation.id, c.var.workspace.installationId),
          isNull(schema.githubInstallation.suspendedAt),
        ),
      );
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
    // Repo lists always come through the Router's short cache, whose isolate keeps the ETags.
    const router = c.env.ROUTER.getByName(c.var.workspace.id);
    const orgs = await Promise.all(
      installations.map(async (installation) => {
        const personal = installation.accountType === "User";
        try {
          // Read once (a query builder runs again on each `then`), alongside the org's runners.
          const repos = Promise.resolve(
            privateRepos(c.var.db, installation.id, {
              fullName: lookup
                ? lookup.includes("/")
                  ? lookup
                  : `${installation.org}/${lookup}`
                : undefined,
            }),
          );
          const [org, onRepos, searched] = await Promise.all([
            personal || lookup
              ? { runners: [], access: new Map<number, GroupAccess>() }
              : groups
                ? readRunners(c.env, installation.id, { kind: "org", org: installation.org })
                : cachedRunners(router, installation.id, installation.org).then((runners) => ({
                    runners,
                    access: new Map<number, GroupAccess>(),
                  })),
            repos.then(async (all) => {
              const repos = all.slice(0, MAX_RUNNER_REPOS);
              const lists = await router.githubRunnerLists(
                installation.id,
                repos.map((repo) => ({ kind: "repo", repo: repo.fullName }) as const),
                { fresh },
              );
              // A repo GitHub won't list (no repository Administration there) is left out.
              return repos.flatMap(
                (repo, i) => lists[i]?.map((runner) => ({ runner, repo })) ?? [],
              );
            }),
            repos.then((all) => all.length),
          ]);
          const lastJobAt = await recentRunnerJobs(c.var.db, installation.id);
          const found = [
            ...org.runners.map((runner) => ({
              runner,
              repo: null,
              access: org.access.get(runner.id),
            })),
            ...onRepos.map(({ runner, repo }) => ({ runner, repo, access: undefined })),
          ];
          return {
            installationId: installation.id,
            org: installation.org,
            personal,
            // More private repos than were searched: look in one by name (`?repo=`).
            moreRepos: searched > MAX_RUNNER_REPOS,
            // The repo `?repo=` named isn't one of the account's private repos.
            repoNotFound: lookup !== null && searched === 0,
            runners: found
              .filter(({ runner }) => !isHiddenRunner(runner))
              .map(({ runner, repo, access }) =>
                presentGithubRunner(runner, {
                  access,
                  repo,
                  lastJobAt: lastJobAt(runner.name, repo?.id ?? null),
                  machineId:
                    added.find(
                      (m) => m.installationId === installation.id && m.githubRunnerId === runner.id,
                    )?.id ?? null,
                }),
              ),
          };
        } catch (error) {
          console.warn(
            JSON.stringify({
              msg: "github runners unavailable",
              installationId: installation.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          return {
            installationId: installation.id,
            org: installation.org,
            personal,
            error: "unavailable",
          };
        }
      }),
    );
    return c.json({ orgs });
  })
  // Adds runners to the workspace, from the org or from one repo (`repositoryId`): each gets
  // RelayRunner's routing label on GitHub and a machine row, and routes like a connected machine
  // from then on. Nothing changes on the machine.
  .post("/github-runners", requireUser, requireWorkspace, requireManager, async (c) => {
    const parsed = AddRunnersBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const { installationId, repositoryId, runnerIds } = parsed.data;
    const { db, workspace, user } = c.var;
    const [installation] = await db
      .select({
        org: schema.githubInstallation.accountLogin,
        accountType: schema.githubInstallation.accountType,
      })
      .from(schema.githubInstallation)
      .where(
        and(
          eq(schema.githubInstallation.id, installationId),
          eq(schema.githubInstallation.id, workspace.installationId),
        ),
      )
      .limit(1);
    if (!installation) throw new AppError("NOT_FOUND");
    // A repo runner's repo must be one of the installation's private repos, and only an org has
    // org runners.
    const [repo] = repositoryId ? await privateRepos(db, installationId, { id: repositoryId }) : [];
    if (repositoryId && !repo) throw new AppError("NOT_FOUND");
    if (!repo && installation.accountType === "User") throw new AppError("NOT_FOUND");
    const scope: RunnerScope = repo
      ? { kind: "repo", repo: repo.fullName }
      : { kind: "org", org: installation.org };
    const { token, runners, access } = await readRunners(c.env, installationId, scope);
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
      await addRunnerLabels(token, scope, runner.id, [routingLabel]);
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
          githubRepositoryId: repo?.id ?? null,
          routingLabel,
          githubLabels: JSON.stringify([...runner.labels, routingLabel]),
          // The org's runner, usually shared team hardware: it takes anyone's jobs (#242).
          sharing: "anyone",
        })
        .returning();
      // Jobs it already ran show under it from the start.
      await claimRunnerJobs(db, machine);
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
  // repos" or "Repo runner · acme/app", for its card's menu. Read on demand: it takes several GitHub calls (the org's runner
  // groups, then each group's runners and repos), so the Runners page doesn't wait on it.
  .get("/:id/access", requireUser, requireWorkspace, async (c) => {
    const [machine] = await c.var.db
      .select()
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.id, c.req.param("id")),
          inWorkspace(c.var.db, c.var.workspace.id),
          isNull(schema.machine.revokedAt),
        ),
      );
    if (!machine) throw new AppError("NOT_FOUND");
    const scope = machine.source === "github" ? await addedMachineScope(c.var.db, machine) : null;
    if (!scope || !machine.installationId || !machine.githubRunnerId)
      return c.json({ access: null });
    // A repo runner takes only its repo's jobs; it has no runner group to read.
    if (scope.kind === "repo") return c.json({ access: describeRepoAccess(scope.repo) });
    try {
      const { access } = await readRunners(c.env, machine.installationId, scope);
      return c.json({ access: describeAccess(access.get(machine.githubRunnerId)) });
    } catch {
      // GitHub couldn't be asked; the menu just leaves the line out.
      return c.json({ access: null });
    }
  })
  // Puts the signed-in user's own machines in this workspace (#365). Anyone's machines but theirs
  // are skipped, as are ones already here. `added` is the ids that joined.
  .post("/workspace", requireUser, requireWorkspace, async (c) => {
    const parsed = AddToWorkspaceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("INVALID_REQUEST");
    const added = await addMachinesToWorkspace(c.var.db, {
      userId: c.var.user!.id,
      workspaceId: c.var.workspace.id,
      machineIds: [...new Set(parsed.data.machineIds)],
    });
    return c.json({ added });
  })
  // Takes one of the signed-in user's own machines out of this workspace. Only its owner may: it's
  // their computer. It stays connected and keeps taking jobs in its other workspaces.
  .delete("/:id/workspace", requireUser, requireWorkspace, async (c) => {
    const [machine] = await c.var.db
      .select({ id: schema.machine.id, name: schema.machine.name, userId: schema.machine.userId })
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.id, c.req.param("id")),
          inWorkspace(c.var.db, c.var.workspace.id),
          eq(schema.machine.source, "connect"),
          isNull(schema.machine.revokedAt),
        ),
      )
      .limit(1);
    if (!machine) throw new AppError("NOT_FOUND");
    if (machine.userId !== c.var.user!.id) throw new AppError("MACHINE_NOT_OWNED");
    await removeMachineFromWorkspace(c.var.db, machine, c.var.workspace.id, c.var.user!.id);
    return c.json({ removed: machine.id });
  })
  .delete("/:id", requireUser, requireWorkspace, async (c) => {
    const machineId = c.req.param("id");
    const { role, user, workspace, db } = c.var;
    const [target] = await db
      .select({
        id: schema.machine.id,
        source: schema.machine.source,
        userId: schema.machine.userId,
      })
      .from(schema.machine)
      .where(
        and(
          eq(schema.machine.id, machineId),
          inWorkspace(db, workspace.id),
          isNull(schema.machine.revokedAt),
        ),
      )
      .limit(1);
    if (!target) throw new AppError("NOT_FOUND");
    // A connected machine only by its owner; a runner added from GitHub, which belongs to the
    // org, by owners and admins (#318).
    if (!canControlMachine(role, user!.id, target)) throw new AppError("FORBIDDEN");
    const [machine] = await revokeMachines(c.env, db, eq(schema.machine.id, target.id), user!.id);
    if (!machine) throw new AppError("NOT_FOUND");
    if (machine.source === "github") await removeRoutingLabel(c.env, db, machine);
    return c.json({ machine: presentMachine(machine) });
  });

/** An org's runners from the Router's short cache; throws when GitHub couldn't be asked. */
async function cachedRunners(
  router: {
    githubRunners(
      installationId: number,
      scope: RunnerScope,
    ): Promise<{ runners: GitHubRunner[]; checkedAt: number } | null>;
  },
  installationId: number,
  org: string,
) {
  const list = await router.githubRunners(installationId, { kind: "org", org });
  if (!list) throw new AppError("GITHUB_UNAVAILABLE");
  return list.runners;
}

/** What the add dialog shows of a runner on GitHub: an org runner, or one registered on `repo`. */
function presentGithubRunner(
  runner: GitHubRunner,
  {
    access,
    repo,
    lastJobAt,
    machineId,
  }: {
    // An org runner's group access, when it was read.
    access: GroupAccess | undefined;
    repo: { id: number; fullName: string } | null;
    // When it last finished a job, from job_timing, or null.
    lastJobAt: Date | null;
    // The machine it's already added as, or null.
    machineId: string | null;
  },
) {
  return {
    id: runner.id,
    name: runner.name,
    os: runnerOs(runner),
    arch: runnerArch(runner),
    status: runner.status,
    busy: runner.busy,
    labels: matchLabels(runner.labels),
    // "Default group · all private repos", "Repo runner · acme/app", or null.
    access: repo ? describeRepoAccess(repo.fullName) : describeAccess(access),
    // Why it can't be added ("workflows": its group only allows selected workflows), or null.
    blocked: cannotAdd(runner, access),
    machineId,
    repo,
    lastJobAt: lastJobAt?.toISOString() ?? null,
  };
}

// Runners seen in jobs this long ago or less count as recently used.
const RECENT_JOB_DAYS = 14;

/**
 * When each runner in the installation last finished a job, from job_timing (which records every
 * job's runner name, whoever routed it). Runner names are unique per org or per repo, so an org
 * runner matches by name across repos and a repo runner by name on its own repo.
 */
async function recentRunnerJobs(db: Db, installationId: number) {
  const t = schema.jobTiming;
  const rows = await db
    .select({ name: t.runnerName, repositoryId: t.repositoryId, at: max(t.completedAt) })
    .from(t)
    .where(
      and(
        eq(t.installationId, installationId),
        gt(t.completedAt, new Date(Date.now() - RECENT_JOB_DAYS * 86_400_000)),
        isNotNull(t.runnerName),
      ),
    )
    .groupBy(t.runnerName, t.repositoryId);
  return (name: string, repositoryId: number | null): Date | null => {
    let latest: Date | null = null;
    for (const row of rows) {
      if (row.name !== name || (repositoryId !== null && row.repositoryId !== repositoryId))
        continue;
      if (row.at && (!latest || row.at > latest)) latest = row.at;
    }
    return latest;
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
  if (!result) throw new AppError("NOT_FOUND");
  const by = await pausedByName(db, result.machine);
  const link = env.MACHINE_LINK.getByName(machineId);
  if (result.changed) await link.notifyPaused(paused, by);
  return Response.json({
    machine: { ...presentMachine(result.machine, by), status: await link.status() },
  });
}

// The machine a `Bearer rrm_…` header belongs to, or null.
async function machineFromToken(db: ReturnType<typeof createDb>, header: string | undefined) {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const machine = await verifyMachineToken(db, token);
  annotate({ "relayrunner.machine_id": machine?.id, "user.id": machine?.userId });
  return machine;
}

// What `relayrunner workspaces` shows: the machine, the owner's workspaces it takes jobs in, and
// their others.
async function presentWorkspaceChoice(
  db: ReturnType<typeof createDb>,
  machine: { id: string; name: string; sharing: string; userId: string | null },
) {
  const [mine, rows] = await Promise.all([
    machine.userId ? userWorkspaces(db, machine.userId) : Promise.resolve([]),
    db
      .select({ workspaceId: schema.machineWorkspace.workspaceId })
      .from(schema.machineWorkspace)
      .where(eq(schema.machineWorkspace.machineId, machine.id)),
  ]);
  const listed = new Set(rows.map((row) => row.workspaceId));
  return {
    machine: { id: machine.id, name: machine.name, sharing: machine.sharing },
    workspaces: mine.filter((workspace) => listed.has(workspace.id)),
    others: mine.filter((workspace) => !listed.has(workspace.id)),
  };
}

// Better Auth's device errors carry an RFC 8628 code in the body; give each its own code.
const DEVICE_ERRORS: Record<string, ErrorCode> = {
  expired_token: "DEVICE_CODE_EXPIRED",
  device_code_already_processed: "DEVICE_CODE_USED",
  access_denied: "DEVICE_CODE_CLAIMED",
};
function deviceError(error: unknown) {
  if (!(error instanceof APIError)) return error;
  const body = error.body as { error?: string } | undefined;
  return new AppError(DEVICE_ERRORS[body?.error ?? ""] ?? "DEVICE_CODE_INVALID", { cause: error });
}
