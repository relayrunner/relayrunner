# @relayrunner/access

Verifies the JWT that [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) adds to every request it lets through (`Cf-Access-Jwt-Assertion`), and gates the operator `/admin` views on it. Access already blocks unauthenticated requests at the edge; checking the token in the Worker too means a route stays closed if the Access app is removed or misconfigured, and tells the Worker who the caller is: a person or a service token.

It uses WebCrypto, so it runs in Workers and in Node tests.

Used by [`apps/api`](../../apps/api) and [`apps/web`](../../apps/web).

## Usage

```ts
import { gateAdmin, isAdminPath } from "@relayrunner/access";

if (isAdminPath(url.pathname)) {
  const gate = await gateAdmin(request, env);
  if ("response" in gate) return gate.response;
  // gate.identity is { kind: "user", email, sub } or { kind: "service", clientId }
}
```

`gateAdmin` answers `404` when Access isn't configured for the Worker, so an admin view can never leak by forgetting to set it up, and `403` when the token is missing or invalid. Admin paths are `/admin` and `/api/admin` and everything under them.

For other routes, `accessConfig(env)` reads the config and `verifyAccessRequest(request, config)` checks a request.

## Configuration

| Variable             | What it is                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN` | The Zero Trust team domain, such as `relayrunner.cloudflareaccess.com`.                         |
| `ACCESS_AUD`         | Comma-separated Application Audience (AUD) tags of the Access apps allowed to reach the Worker. |

See [docs/cloudflare-access.md](../../docs/cloudflare-access.md) for what is protected and how agents get in.
