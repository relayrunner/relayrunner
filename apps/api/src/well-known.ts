import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { createAuth } from "./auth.ts";
import type { Env } from "./env.ts";

// OAuth discovery at the dashboard's root, for agent sign-in (agent-auth.ts). The issuer is
// <dashboard>/api/auth, so MCP clients look for /.well-known/oauth-authorization-server/api/auth
// (RFC 8414) or /.well-known/openid-configuration/api/auth, outside the /api the app serves. The
// dashboard Worker forwards /.well-known/* here. Null for any other path.
export function wellKnown(request: Request, env: Env) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
    return oauthProviderAuthServerMetadata(createAuth(env))(request);
  }
  if (pathname.startsWith("/.well-known/openid-configuration")) {
    return oauthProviderOpenIdConfigMetadata(createAuth(env))(request);
  }
  return null;
}
