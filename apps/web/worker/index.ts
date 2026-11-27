/**
 * Dashboard Worker. Serves the SPA from static assets and forwards /api/* to
 * the API Worker (apps/api) over a service binding, so the browser only ever
 * sees one origin. That keeps Better Auth cookies first-party on workers.dev
 * and on app.relayrunner.dev, without a route on the API Worker.
 * GitHub webhooks (/api/webhooks/*) go to the webhook ingress Worker
 * (apps/webhooks) instead, which queues them for the API.
 *
 * Operator admin views (/admin/* and /api/admin/*) need a Cloudflare Access JWT
 * (see packages/access). They answer 404 wherever Access isn't configured. The
 * old /dev/* paths redirect to /admin/* (public/_redirects).
 *
 * /ingest/* is PostHog analytics, forwarded so it stays first-party (packages/posthog-proxy).
 *
 * /evaluate/<provider> is the public Evaluate page, served with its share tags written in
 * (evaluate-meta.ts) so link previews show the provider's share image.
 *
 * `run_worker_first` in wrangler.jsonc sends /api/*, /admin/*, /.well-known/*, /ingest/* and
 * /evaluate/* here before the assets layer; every other path is answered by assets (with the SPA
 * fallback).
 */
import { gateAdmin, isAdminPath, type AccessEnv } from "@relayrunner/access";
import { isPostHogPath, proxyPostHog } from "@relayrunner/posthog-proxy";
import { evaluatePage } from "./evaluate-meta";

interface Env extends AccessEnv {
  API: Fetcher;
  WEBHOOKS: Fetcher;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (isPostHogPath(pathname)) return proxyPostHog(request);
    if (pathname.startsWith("/api/webhooks/")) {
      return env.WEBHOOKS.fetch(request);
    }
    if (isAdminPath(pathname)) {
      const gate = await gateAdmin(request, env);
      if ("response" in gate) return gate.response;
      // Who Access let in: lets an agent check its service token before it drives an admin view.
      if (pathname === "/admin/access") return Response.json({ identity: gate.identity });
    }
    // OAuth discovery for agent sign-in (apps/api/src/auth/well-known.ts).
    if (
      pathname === "/api" ||
      pathname.startsWith("/api/") ||
      pathname.startsWith("/.well-known/")
    ) {
      return env.API.fetch(request);
    }
    return (await evaluatePage(request, env.ASSETS)) ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
