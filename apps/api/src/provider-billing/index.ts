import type { BillingProviderId } from "@relayrunner/providers";
import { blacksmith } from "./blacksmith.ts";
import { boat } from "./boat.ts";
import { depot } from "./depot.ts";
import { namespace } from "./namespace.ts";
import type { BillingAdapter } from "./types.ts";
import { warpbuild } from "./warpbuild.ts";

export const ADAPTERS: Record<BillingProviderId, BillingAdapter> = {
  blacksmith,
  boat,
  depot,
  namespace,
  warpbuild,
};

export {
  type AdapterContext,
  type DailyUsage,
  type JobUsage,
  ProviderApiError,
  ProviderAuthError,
  type Usage,
  type UsageWindow,
} from "./types.ts";
