// Where a device-code request came from, so the /device approval page can show it. Anyone can run
// `relayrunner connect` and send someone else the approval link; showing "Requested from Lisbon,
// PT" and warning when that's a different country from the approver gives them a reason to stop.
// Cloudflare fills these in at its edge: `cf-connecting-ip`, and `request.cf` (country, city).

export interface RequestOrigin {
  ip: string | null;
  country: string | null;
  city: string | null;
}

type CfProperties = { country?: unknown; city?: unknown };

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/** The request's IP, country (ISO 3166 alpha-2) and city, each null when Cloudflare didn't say. */
export function requestOrigin(request: Request | undefined): RequestOrigin {
  const cf = (request as (Request & { cf?: CfProperties }) | undefined)?.cf;
  // XX and T1 are Cloudflare's "unknown" and "Tor", neither a place to show.
  const country = text(cf?.country, 2)?.toUpperCase() ?? null;
  return {
    ip: text(request?.headers.get("cf-connecting-ip"), 64),
    country: country && country !== "XX" && country !== "T1" ? country : null,
    city: text(cf?.city, 80),
  };
}

/**
 * A RequestOrigin passed along as JSON (MachineLink gets one in a header, since request.cf doesn't
 * reach a Durable Object), cleaned like requestOrigin's. Undefined when missing or unreadable.
 */
export function originFromJson(json: string | null): RequestOrigin | undefined {
  if (!json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const { ip, country, city } = value as Record<string, unknown>;
  return { ip: text(ip, 64), country: text(country, 2), city: text(city, 80) };
}

/**
 * What the approval page shows about where the code came from. `differentCountry` is true only
 * when both sides' countries are known and differ; null when either is unknown.
 */
export function presentOrigin(
  requested: { country: string | null; city: string | null },
  approver: { country: string | null },
) {
  if (!requested.country && !requested.city) return null;
  return {
    country: requested.country,
    city: requested.city,
    differentCountry:
      requested.country && approver.country ? requested.country !== approver.country : null,
  };
}
