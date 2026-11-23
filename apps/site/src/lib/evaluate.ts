// The dashboard's provider evaluation (apps/web/src/routes/evaluate.$provider.tsx) starts publicly,
// so the site can link a visitor straight into it with the runner picked.
import { AUTO_SIZES, labelForSize } from "@relayrunner/providers";

/** Runners the dashboard can evaluate: ones with a Linux label for an auto size, besides GitHub's. */
export const evaluable = (id: string) =>
  id !== "github" && AUTO_SIZES.some((vcpus) => labelForSize(id, vcpus, 0));

/** The evaluation's first step for `id`. */
export const evaluateHref = (id: string) => `https://app.relayrunner.dev/evaluate/${id}`;
