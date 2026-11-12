// Every provider, with the ones operators changed or added in the admin (GET /api/providers/catalog),
// for the pages that name, link and describe providers. The workspace layout loads it before any
// page renders; until then, and if it can't be read, it's the code list in @relayrunner/providers.
import { BASE_CATALOG, type CatalogProvider } from "@relayrunner/providers/catalog";
import { api } from "@/lib/api";
import { authDisabled } from "@/lib/auth-client";

let catalog: CatalogProvider[] = BASE_CATALOG;
let byId = new Map(catalog.map((p) => [p.id, p]));
let loading: Promise<void> | undefined;

/** Reads the list once per page load. The admin calls setProviderCatalog after a change. */
export function loadProviderCatalog(): Promise<void> {
  if (authDisabled) return Promise.resolve();
  loading ??= api<{ providers: CatalogProvider[] }>("/providers/catalog")
    .then(({ providers }) => setProviderCatalog(providers))
    .catch(() => {
      loading = undefined;
    });
  return loading;
}

export function setProviderCatalog(providers: CatalogProvider[]) {
  catalog = providers;
  byId = new Map(providers.map((p) => [p.id, p]));
}

/** Every provider, in the order the admin lists them. */
export const providerCatalog = () => catalog;

/** Whether `id` is a provider, including ones operators added. */
export const isKnownProvider = (id: string) => byId.has(id);

/** A provider's name, text and links; Other's for an id that isn't one. */
export const providerInfo = (id: string): CatalogProvider => byId.get(id) ?? byId.get("other")!;
