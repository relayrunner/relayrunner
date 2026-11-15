import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 0.62 → "62%". */
export const percent = (share: number) => `${Math.round(share * 100)}%`;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** A count as people skim it: "999", then "1.1K", "24K", "1.2M". `exact()` gives the full number. */
export const count = (value: number) => compact.format(value);

/** "1,204": the full number, for a count's hover. */
export const exact = (value: number) => value.toLocaleString("en-US");

/** "52s", "3m 51s", "1h 2m"; "—" for none. */
export function elapsed(ms: number | null) {
  if (ms === null) return "—";
  // GitHub times jobs and steps to the whole second, so under one reads "<1s" and not "0s".
  if (ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * A chart's top for counts up to `max`: a round number (such as 2, 5, 12 or 50) with some
 * headroom, so the tallest bar doesn't touch the top.
 */
export function niceMax(max: number) {
  const target = Math.max(1, max * 1.1);
  const power = 10 ** Math.floor(Math.log10(target));
  return (
    ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((step) => step * power >= target) ?? 10) * power
  );
}
