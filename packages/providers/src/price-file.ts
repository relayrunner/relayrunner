// A price file: the prices a provider publishes on its own site for RelayRunner to read, so a
// price change needs no pull request. An operator sets the file's URL in Admin › Providers and the
// daily price check reads it (apps/api/src/providers/price-check.ts). The format is strict: one
// field out of place and the whole file is ignored, so a broken file never applies half its prices.
// The docs page "Publish your prices" (apps/site) describes it for providers.
import { type FoundPrice, found, type PriceSource } from "./price-sources.ts";
import { isDay, rateUnit } from "./prices.ts";

/** Where the docs suggest a provider puts its file. */
export const PRICE_FILE_PATH = "/.well-known/relayrunner-prices.json";

const ROOT_KEYS = new Set(["version", "prices"]);
const PRICE_KEYS = new Set(["rate", "per", "usd_per_minute", "from"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, allowed: Set<string>, where: string) {
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new Error(`${where}: unknown field "${extra}"`);
}

/**
 * The prices in a provider's price file. Throws on anything that doesn't match the format, or on a
 * price whose `per` disagrees with how RelayRunner prices that rate. Rates RelayRunner doesn't have
 * yet are left out, since nothing could be priced with them.
 */
export function parsePriceFile(provider: string, body: string): FoundPrice[] {
  let file: unknown;
  try {
    file = JSON.parse(body);
  } catch {
    throw new Error("not JSON");
  }
  if (!isObject(file)) throw new Error("not a JSON object");
  onlyKeys(file, ROOT_KEYS, "file");
  if (file.version !== 1) throw new Error("version must be 1");
  if (!Array.isArray(file.prices) || file.prices.length === 0)
    throw new Error("prices must be a list with at least one price");

  const seen = new Set<string>();
  return file.prices.flatMap((entry: unknown, i): FoundPrice[] => {
    const where = `prices[${i}]`;
    if (!isObject(entry)) throw new Error(`${where}: not an object`);
    onlyKeys(entry, PRICE_KEYS, where);
    const { rate, per, usd_per_minute: usd, from } = entry;
    if (typeof rate !== "string" || !rate) throw new Error(`${where}: rate must be a string`);
    if (per !== "vcpu" && per !== "runner")
      throw new Error(`${where}: per must be "vcpu" or "runner"`);
    // A string, so no price is rounded on its way through JSON.
    if (typeof usd !== "string" || !/^\d+(\.\d+)?$/.test(usd))
      throw new Error(`${where}: usd_per_minute must be a decimal string, like "0.004"`);
    if (from !== undefined && (typeof from !== "string" || !isDay(from)))
      throw new Error(`${where}: from must be a day, like "2026-12-01"`);
    const key = `${rate} ${from ?? ""}`;
    if (seen.has(key)) throw new Error(`${where}: ${rate} is listed twice for the same day`);
    seen.add(key);

    const unit = rateUnit(provider, rate);
    if (unit === null) return [];
    if (unit !== per) throw new Error(`${where}: ${rate} is priced per ${unit}, not per ${per}`);
    return [found(rate, Number(usd), from)];
  });
}

/** The price check's source for a provider's price file. */
export const priceFileSource = (provider: string, url: string): PriceSource => ({
  provider,
  url,
  page: url,
  parse: (body) => parsePriceFile(provider, body),
  fromProvider: true,
});
