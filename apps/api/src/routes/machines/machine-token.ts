import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { MACHINE_SHARING } from "@relayrunner/activity";
import { z } from "zod";
import type { AppEnv } from "../../app.ts";
import { createDb, schema } from "../../db/index.ts";
import { requestOrigin } from "../../machines/device-origin.ts";
import { FAILED_CONCLUSIONS } from "../../ingest/job-counts.ts";
import { MACHINE_ID_HEADER, MACHINE_ORIGIN_HEADER } from "../../durable-objects/machine-session.ts";
import {
  addMachinesToWorkspace,
  pausedByName,
  presentMachine,
  presentMachineWorkspaces,
  removeMachineFromWorkspace,
  setMachinePaused,
  setMachineSharing,
  userWorkspaces,
  type PauseActor,
} from "../../machines/machines.ts";
import type { Env } from "../../env.ts";
import { isBillingProvider } from "@relayrunner/providers";
import {
  chooseWorkspace,
  connectProvider,
  managedWorkspaces,
  parseOptions,
} from "../../providers/provider-connections.ts";
import { AppError } from "@relayrunner/errors";
import { machineJobFailure } from "../../reports/job-failures.ts";
import {
  JOB_RESULTS,
  MAX_MACHINE_JOBS,
  machineJob,
  machineJobs,
  machineJobSteps,
  machineWorkspaceFor,
} from "../../machines/machine-jobs.ts";
import { requireMachine } from "../../middleware/machine.ts";

// Routes a machine calls as itself, with its token: `Authorization: Bearer rrm_…`. A missing,
// unknown or revoked token gets a 401 (requireMachine).

const JobId = z.coerce.number().int().positive();
const JobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_MACHINE_JOBS).optional(),
  before: z.coerce.number().int().positive().optional(),
  repo: z.string().min(1).max(200).optional(),
  workflow: z.string().min(1).max(200).optional(),
  result: z.enum(JOB_RESULTS).optional(),
  since: z.coerce.number().int().positive().optional(),
});

export const SharingBody = z.object({ sharing: z.enum(MACHINE_SHARING) });
const MachineConnectBody = z.object({
  token: z.string().trim().min(8).max(4096),
  options: z.record(z.string(), z.string()).optional(),
  workspace: z.string().trim().min(1).max(200).optional(),
});

export const machineTokenRoutes = new Hono<AppEnv>()
  // The machine's WebSocket: `Upgrade: websocket` with `Authorization: Bearer rrm_…`. A missing,
  // unknown or revoked token gets a 401 before the upgrade. After that the machine sends `hello`,
  // then `status` as a heartbeat (src/durable-objects/machine-session.ts has the timings and
  // close codes). The token is checked first because a failed upgrade hides its status from the
  // CLI, so it asks with a plain GET: 401 means sign in again, 426 means the token is fine.
  .get("/connect", requireMachine, async (c) => {
    const { machine } = c.var;
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
  .get("/me", requireMachine, async (c) => {
    const db = createDb(c.env.DB);
    const { machine } = c.var;

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
  .put("/me/sharing", requireMachine, async (c) => {
    const db = createDb(c.env.DB);
    const { machine } = c.var;
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
  .get("/me/jobs", requireMachine, async (c) => {
    const db = createDb(c.env.DB);
    const { machine } = c.var;
    const query = JobsQuery.safeParse(c.req.query());
    if (!query.success) throw new AppError("INVALID_REQUEST");
    return c.json(await machineJobs(db, machine.id, query.data));
  })
  // One of them with its steps from GitHub (null when GitHub no longer has the job) and, for a
  // failed one, why, as /failure has it (null otherwise), read together. 404 when the job didn't
  // run on this machine.
  .get("/me/jobs/:jobId", requireMachine, async (c) => {
    const db = createDb(c.env.DB);
    const { machine } = c.var;
    const jobId = JobId.safeParse(c.req.param("jobId"));
    if (!jobId.success) throw new AppError("INVALID_REQUEST");
    const found = await machineJob(db, machine.id, jobId.data);
    if (!found) throw new AppError("NOT_FOUND");
    const failed = FAILED_CONCLUSIONS.includes(found.job.conclusion ?? "");
    const [steps, failure] = await Promise.all([
      machineJobSteps(c.env, found.job, found.installationId),
      failed
        ? machineWorkspaceFor(db, machine, found.installationId).then((workspaceId) =>
            machineJobFailure(db, c.env, machine.id, jobId.data, workspaceId),
          )
        : null,
    ]);
    return c.json({ job: found.job, steps, failure });
  })
  // Why one of them failed: the failed step, annotations, a log excerpt and, when the workspace has
  // AI on, the likely cause. 404 when it didn't run here or didn't fail.
  .get("/me/jobs/:jobId/failure", requireMachine, async (c) => {
    const db = createDb(c.env.DB);
    const { machine } = c.var;
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
  .get("/me/workspaces", requireMachine, async (c) => {
    const db = createDb(c.env.DB);
    const { machine } = c.var;
    return c.json(await presentWorkspaceChoice(db, machine));
  })
  // Adds the machine to, or takes it out of, one of its owner's workspaces. The token lives on the
  // owner's computer, so the change is logged as theirs.
  .on(["PUT", "DELETE"], "/me/workspaces/:workspaceId", requireMachine, async (c) => {
    const db = createDb(c.env.DB);
    const { machine } = c.var;
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
  // Connects a provider account for one of the owner's workspaces, for `relayrunner blacksmith
  // connect`: `Authorization: Bearer rrm_…`, 401 like /me. The owner must own or administer that
  // workspace, as in Settings → Providers. `workspace` (an id, slug or name) picks one; without it, the
  // workspace installed on the provider's organization, or the owner's only one.
  .put("/me/providers/:provider/connection", requireMachine, async (c) => {
    const db = createDb(c.env.DB);
    const { machine } = c.var;
    if (!machine.userId) throw new AppError("MACHINE_NOT_OWNED");
    const provider = c.req.param("provider");
    if (!isBillingProvider(provider)) throw new AppError("NOT_FOUND");
    const parsed = MachineConnectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError("INVALID_REQUEST", { message: "Send the whole token." });
    const options = parseOptions(provider, parsed.data.options);
    if (!options) throw new AppError("INVALID_REQUEST", { message: "Check the options." });
    const managed = await managedWorkspaces(db, machine.userId);
    if (managed.length === 0)
      throw new AppError("FORBIDDEN", {
        message: "Only a workspace's owners and admins can connect a provider.",
      });
    const workspace = chooseWorkspace(managed, options.organization, parsed.data.workspace);
    if (!workspace)
      throw new AppError(parsed.data.workspace ? "NOT_FOUND" : "PROVIDER_WORKSPACE_UNCLEAR", {
        details: {
          workspaces: managed.map(({ id, name, slug }) => ({ id, name, slug })),
        },
      });
    const result = await connectProvider(c.env, db, {
      workspaceId: workspace.id,
      provider,
      token: parsed.data.token,
      options,
      userId: machine.userId,
    });
    if (!result.ok) throw new AppError(result.error, { details: { reason: result.message } });
    return c.json({
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
      connection: result.connection,
    });
  })
  // Pausing from the machine itself, for `relayrunner pause` and `resume`: `Authorization: Bearer
  // rrm_…`, 401 like /me. Registered before /:id so "me" isn't read as a machine id.
  .post("/me/:action{pause|resume}", requireMachine, async (c) => {
    const db = createDb(c.env.DB);
    const { machine } = c.var;
    return pauseResponse(c.env, db, machine.id, c.req.param("action") === "pause", {
      userId: null,
      via: "cli",
    });
  });

// Pauses or resumes the machine, tells its open connection, and answers with the machine.
export async function pauseResponse(
  env: Env,
  db: ReturnType<typeof createDb>,
  machineId: string,
  paused: boolean,
  actor: PauseActor,
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
