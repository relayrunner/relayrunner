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
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
