import { gateAdmin, type AccessIdentity } from "@relayrunner/access";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";
import { isOperator } from "../roles.ts";

// Every /api/admin/* route sits behind Cloudflare Access (docs/cloudflare-access.md); app.ts mounts
// this once for the whole prefix. This Worker's own workers.dev URL is public, so it checks the
// Access JWT itself and never trusts the dashboard Worker to have done it. Sets
// c.var.accessIdentity.
export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  const gate = await gateAdmin(c.req.raw, c.env);
  if ("response" in gate) return gate.response;
  c.set("accessIdentity", gate.identity);
  await next();
});

// The signed-in user is an operator (user.role). Admin routes that read or change D1 data need
// this as well as Access, so an Access service token alone can't change who is an operator. Run
// it after requireUser.
export const requireOperator = createMiddleware<AppEnv>(async (c, next) => {
  if (!isOperator(c.var.user)) return c.json({ error: "forbidden" }, 403);
  await next();
});

// Who did it, for audit logs: a person's email or a service token's Client ID.
export function who(identity: AccessIdentity) {
  return identity.kind === "user" ? identity.email : identity.clientId;
}
