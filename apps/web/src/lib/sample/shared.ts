// Helpers the sample builders share.

/** A repeatable random number source from `seed`: the same seed gives the same sample. */
export function seededRandom(seed: number) {
  let x = seed;
  return () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
}

/**
 * Whether a `days` window can be compared with the one before: the API keeps raw job timings 62
 * days (RAW_RETENTION_DAYS). The sample reports have no API, so they work it out here.
 */
export const hasTrend = (days: number) => days * 2 <= 62;
