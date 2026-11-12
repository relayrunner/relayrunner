// The provider list the dashboard and reports use: the code list in index.ts with the rows
// operators save in D1 (the API's `provider` table) on top. A row for a provider in code replaces
// its text and links; a row with a new id adds a provider, recognised by its label prefixes, with
// no deploy. Routing and per-size prices stay in code, so an added provider has neither until a
// pull request gives it them. The docs site reads the code list alone.
import {
  isProviderId,
  LABEL_PREFIXES,
  matchesPrefix,
  PROVIDER_IDS,
  PROVIDERS,
  type ProviderInfo,
} from "./index.ts";

export interface CatalogProvider extends ProviderInfo {
  id: string;
  /** Label prefixes that pick out its runners. Empty for ones code matches another way. */
  prefixes: string[];
  /** An https image URL for its mark. Only added providers use it; ones in code have their own. */
  logoUrl?: string;
  /** In the code list. An operator can change its text but not remove it. */
  builtIn: boolean;
  /** Who last saved it in the admin, or null when it's as in code. */
  updatedBy: string | null;
  updatedAt: string | null;
}

/** A provider an operator saved, as the API stores it. */
export interface ProviderRow {
  id: string;
  name: string;
  summary: string;
  labels: string;
  /** Ignored for providers in code, whose labels are matched in code. */
  prefixes: string[];
  example: string | null;
  setup: string | null;
  dashboardUrl: string | null;
  docsUrl: string | null;
  logoUrl: string | null;
  updatedBy: string;
  updatedAt: string;
}

const prefixesOf = (id: string): string[] =>
  Object.hasOwn(LABEL_PREFIXES, id) ? LABEL_PREFIXES[id as keyof typeof LABEL_PREFIXES] : [];

const fromCode = (id: (typeof PROVIDER_IDS)[number]): CatalogProvider => ({
  id,
  ...PROVIDERS[id],
  prefixes: prefixesOf(id),
  builtIn: true,
  updatedBy: null,
  updatedAt: null,
});

export const BASE_CATALOG: CatalogProvider[] = PROVIDER_IDS.map(fromCode);

const optional = (value: string | null) => value || undefined;

/**
 * Every provider: the code list in its order with operators' rows on top, then the ones operators
 * added by name, then Other.
 */
export function providerCatalog(rows: ProviderRow[]): CatalogProvider[] {
  const saved = new Map(rows.map((row) => [row.id, row]));
  const entry = (row: ProviderRow, base?: CatalogProvider): CatalogProvider => ({
    id: row.id,
    name: row.name,
    summary: row.summary,
    labels: row.labels,
    example: optional(row.example),
    setup: optional(row.setup),
    dashboardUrl: optional(row.dashboardUrl),
    docsUrl: optional(row.docsUrl),
    logoUrl: base ? undefined : optional(row.logoUrl),
    prefixes: base ? base.prefixes : row.prefixes,
    builtIn: Boolean(base),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  });
  const merged = (base: CatalogProvider) => {
    const row = saved.get(base.id);
    return row ? entry(row, base) : base;
  };
  const added = rows
    .filter((row) => !isProviderId(row.id))
    .map((row) => entry(row))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Other is last in the code list, and stays last.
  const base = BASE_CATALOG.map(merged);
  return [...base.slice(0, -1), ...added, ...base.slice(-1)];
}

/**
 * The first provider in the list whose prefixes match one of the (lowercase) labels, with that
 * label. Providers in code come first, so an added one never takes their labels.
 */
export function catalogProviderOf(
  catalog: readonly CatalogProvider[],
  labels: readonly string[],
): { id: string; name: string; label: string } | null {
  for (const provider of catalog) {
    const label = labels.find((l) => matchesPrefix(provider.prefixes, l));
    if (label) return { id: provider.id, name: provider.name, label };
  }
  return null;
}

// Ids that mean something else in environment keys and routes.
const RESERVED = new Set(["machine", "container", "self-hosted", "relayrunner", "catalog", "new"]);
// Labels that already mean a runner of GitHub's, a person's own, or RelayRunner's.
const TAKEN_STARTS = ["ubuntu", "windows", "macos", "xcode", "self-hosted", "relayrunner"];

/** Why a new provider can't take this id, or null when it can. */
export function providerIdProblem(catalog: readonly CatalogProvider[], id: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id) || RESERVED.has(id)) return "invalid_id";
  return catalog.some((p) => p.id === id) ? "provider_exists" : null;
}

/**
 * Why an added provider can't use these label prefixes, or null when it can. They mustn't catch
 * labels that already mean another provider or GitHub's own runners.
 */
export function prefixProblem(
  catalog: readonly CatalogProvider[],
  id: string,
  prefixes: readonly string[],
): string | null {
  if (prefixes.length === 0) return "invalid_prefixes";
  for (const prefix of prefixes) {
    if (!/^[a-z0-9][a-z0-9._=/-]{2,}$/.test(prefix)) return "invalid_prefixes";
    // Either one starting the other means some label would match both.
    const bare = prefix.replace(/-$/, "");
    const clash = (other: string) => {
      const theirs = other.replace(/-$/, "");
      return theirs.startsWith(bare) || bare.startsWith(theirs);
    };
    if (TAKEN_STARTS.some(clash)) return "prefix_taken";
    if (catalog.some((p) => p.id !== id && p.prefixes.some(clash))) return "prefix_taken";
  }
  return null;
}
