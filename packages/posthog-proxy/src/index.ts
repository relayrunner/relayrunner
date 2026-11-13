/**
 * Forwards PostHog requests from our own domain to PostHog's US cloud. posthog-js sends to
 * `/ingest` on the page's host (`api_host: "/ingest"`), so analytics stay first-party and ad
 * blockers don't drop them. Static files (the SDK's lazy-loaded extensions, under /static) and the
 * project's remote config (/array) come from the assets host, everything else from the ingestion
 * host.
 */

export const INGEST_PREFIX = "/ingest";
const API_HOST = "us.i.posthog.com";
const ASSETS_HOST = "us-assets.i.posthog.com";

/** Whether a path is ours to forward: `/ingest` or anything under it. */
export function isPostHogPath(pathname: string): boolean {
  return pathname === INGEST_PREFIX || pathname.startsWith(`${INGEST_PREFIX}/`);
}

/** The PostHog URL for a request to `/ingest/...` on our domain. */
export function postHogUrl(url: URL): URL {
  const path = url.pathname.slice(INGEST_PREFIX.length) || "/";
  const asset = path.startsWith("/static/") || path.startsWith("/array/");
  const host = asset ? ASSETS_HOST : API_HOST;
  return new URL(`${path}${url.search}`, `https://${host}`);
}

/**
 * Sends the request on to PostHog. Our cookies (the dashboard's session among them) stay behind,
 * and PostHog gets the visitor's IP for geolocation instead of Cloudflare's.
 */
export function proxyPostHog(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return fetcher(postHogUrl(new URL(request.url)), {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    redirect: "manual",
  });
}
