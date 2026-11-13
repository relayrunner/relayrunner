import type { BillingProviderId } from "@relayrunner/providers";
import { depot } from "./depot.ts";
import { namespace } from "./namespace.ts";
import type { BillingAdapter } from "./types.ts";
import { warpbuild } from "./warpbuild.ts";

export const ADAPTERS: Record<BillingProviderId, BillingAdapter> = { depot, namespace, warpbuild };

export {
  type AdapterContext,
  type DailyUsage,
  type JobUsage,
  ProviderApiError,
  ProviderAuthError,
  type Usage,
  type UsageWindow,
} from "./types.ts";
