import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { APIError } from "better-auth/api";
import { HelloMessage } from "@relayrunner/machine-protocol";
import { z } from "zod";
import type { AppEnv } from "../../app.ts";
import { MACHINE_CLIENT_ID } from "../../auth/auth.ts";
import { createDb, schema } from "../../db/index.ts";
import { presentOrigin, requestOrigin } from "../../machines/device-origin.ts";
import {
  generateMachineToken,
  normalizeUserCode,
  presentMachine,
  presentMachineWorkspaces,
  recordMachineEvents,
  sha256Hex,
  userWorkspaces,
} from "../../machines/machines.ts";
import { sendEmail } from "../../email.ts";
import { inBackground, requireUser } from "../../middleware/session.ts";
import { AppError, type ErrorCode } from "@relayrunner/errors";

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
// Once enrolled, the CLI stays connected over GET /connect (machine-token.ts), a WebSocket to the machine's
// MachineLink Durable Object speaking @relayrunner/machine-protocol.

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

const ClaimBody = z.object({
  deviceCode: z.string().min(1),
  os: HelloMessage.shape.os,
  arch: HelloMessage.shape.arch,
});

const DenyBody = z.object({ userCode: z.string().min(1).max(32) });

export const enrollRoutes = new Hono<AppEnv>()
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
  });

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
