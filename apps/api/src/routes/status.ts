import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { log } from "../log.ts";

// RelayRunner's own service status, for the dashboard's sidebar and banner and the site's footer.
// Better Stack publishes the status page (status.relayrunner.dev) as JSON at /index.json; this reads
// it so browsers never call Better Stack, and answers only what they show: the overall state and,
// while something is wrong, the open incident's or maintenance's title. Public, like /api/health.

export const STATUS_PAGE_URL = "https://status.relayrunner.dev";
const CACHE_SECONDS = 60;

export const SERVICE_STATES = ["operational", "degraded", "downtime", "maintenance"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

/** What GET /api/status answers. `state` is null when the status page couldn't be read. */
export type ServiceStatus = { state: ServiceState | null; incident: string | null };

const statusPage = z.object({
  data: z.object({ attributes: z.object({ aggregate_state: z.string() }) }),
  included: z
    .array(
      z.object({
        type: z.string(),
        attributes: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
});

const report = z.object({
  title: z.string(),
  aggregate_state: z.string().nullish(),
  starts_at: z.string().nullish(),
  ends_at: z.string().nullish(),
});

/** The state and open report title out of Better Stack's index.json. */
export function readStatusPage(body: unknown, now = Date.now()): ServiceStatus {
  const page = statusPage.parse(body);
  const raw = page.data.attributes.aggregate_state;
  const state = (SERVICE_STATES as readonly string[]).includes(raw) ? (raw as ServiceState) : null;
  if (state === null || state === "operational") return { state, incident: null };
  // The newest report that has started, hasn't ended and isn't resolved.
  const open = page.included
    .filter((item) => item.type === "status_report")
    .flatMap((item) => {
      const parsed = report.safeParse(item.attributes);
      return parsed.success ? [parsed.data] : [];
    })
    .filter(
      (r) =>
        r.aggregate_state !== "resolved" &&
        (!r.starts_at || Date.parse(r.starts_at) <= now) &&
        (!r.ends_at || Date.parse(r.ends_at) > now),
    )
    .sort((a, b) => Date.parse(b.starts_at ?? "") - Date.parse(a.starts_at ?? ""));
  return { state, incident: open[0]?.title ?? null };
}

export const statusRoutes = new Hono<AppEnv>().get("/", async (c) => {
  // The site reads this from relayrunner.dev, and the answer is the same public page for everyone.
  c.header("access-control-allow-origin", "*");
  let status: ServiceStatus = { state: null, incident: null };
  try {
    const res = await fetch(`${STATUS_PAGE_URL}/index.json`, {
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`status page answered ${res.status}`);
    status = readStatusPage(await res.json());
  } catch (error) {
    log.warn("status.read_failed", "couldn't read the status page", { error });
  }
  c.header("cache-control", `public, max-age=${status.state ? CACHE_SECONDS : 15}`);
  return c.json(status);
});
