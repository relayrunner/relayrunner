// The dashboard's provider evaluation (apps/web/src/routes/evaluate.$provider.tsx) starts publicly,
// so the site can link a visitor straight into it with the runner picked.
import {
  AUTO_SIZES,
  BASE_BOOK,
  githubRate,
  isProviderId,
  labelForSize,
  listRate,
  providerPlans,
  runnerSize,
} from "@relayrunner/providers";

/** Runners the dashboard can evaluate: ones with a Linux label for an auto size, besides GitHub's. */
export const evaluable = (id: string) =>
  id !== "github" && AUTO_SIZES.some((vcpus) => labelForSize(id, vcpus, 0));

/** The evaluation's first step for `id`. */
export const evaluateHref = (id: string) => `https://app.relayrunner.dev/evaluate/${id}`;

/**
 * The run times on the Evaluate share image (/og/evaluate/<id>.png): a sample workflow that takes
 * 3:28 on GitHub's ubuntu-latest and 2:04 on the provider. The times are illustrative; the costs
 * are what those runs list at today.
 */
const SAMPLE_RUN_MS = { today: 208_000, provider: 124_000 };

/**
 * The sample runs, each with its cost at list prices, the way the dashboard's evaluation prices it: the run time rounded up
 * to whole minutes, at the runner's price per minute. GitHub's is ubuntu-latest in a private repo;
 * the provider's is its 2 vCPU Linux runner (its smallest size when it has none), from its price
 * list, or its plan's 2 vCPU minute scaled by size. Null when the provider has no list price.
 */
export function sampleRuns(id: string) {
  const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
  const github = githubRate(BASE_BOOK, "linux-2-core") ?? 0;
  const label = (
    labelForSize(id, 2, 0) ?? AUTO_SIZES.map((vcpus) => labelForSize(id, vcpus, 0)).find(Boolean)
  )?.toLowerCase();
  let rate: number | null = null;
  if (label && isProviderId(id)) {
    rate = listRate(BASE_BOOK, id, label);
    const perMinute = providerPlans(id)?.perMinute;
    const vcpus = runnerSize(id, label)?.vcpus;
    if (rate === null && perMinute && vcpus) rate = (perMinute / 2) * vcpus;
  }
  return {
    today: { ms: SAMPLE_RUN_MS.today, usd: minutes(SAMPLE_RUN_MS.today) * github },
    provider: {
      ms: SAMPLE_RUN_MS.provider,
      usd: rate === null ? null : minutes(SAMPLE_RUN_MS.provider) * rate,
    },
  };
}
