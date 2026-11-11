// Operator admin views: paths that only people and agents let through by Cloudflare Access may
// reach. Everywhere else (production workers.dev today, which has no Access app) they answer 404,
// so an admin view can never leak by forgetting to configure Access.
import {
  accessConfig,
  verifyAccessRequest,
  type AccessEnv,
  type AccessIdentity,
  type VerifyOptions,
} from "./jwt.ts";

const ADMIN_PREFIXES = ["/admin", "/api/admin"];

export function isAdminPath(pathname: string) {
  return ADMIN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// Returns a Response to send instead (404 when Access isn't configured, 403 when the token is
// missing or invalid), or the caller's identity when the request may continue.
export async function gateAdmin(
  request: Request,
  env: AccessEnv,
  options?: VerifyOptions,
): Promise<{ response: Response } | { identity: AccessIdentity }> {
  const config = accessConfig(env);
  if (!config) return { response: Response.json({ error: "not_found" }, { status: 404 }) };
  const result = await verifyAccessRequest(request, config, options);
  if (!result.ok) {
    return {
      response: Response.json({ error: "forbidden", reason: result.reason }, { status: 403 }),
    };
  }
  return { identity: result.identity };
}
