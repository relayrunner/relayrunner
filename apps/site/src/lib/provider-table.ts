// The runner table on /integrations. Its rows come from @relayrunner/providers/runner-table, the same
// table the dashboard's Providers page shows; this adds the site's links and logos and the featured cards.
import { PROVIDERS } from "@relayrunner/providers";
import {
  cellKey,
  entryPlan,
  minuteText,
  RUNNER_TABLE_ROWS,
  type RunnerTableRow,
  UNPRICED_TABLE_ROWS,
} from "@relayrunner/providers/runner-table";
import { integrationPath, type IntegrationId } from "./integrations";

export {
  cellKey,
  hourText,
  includedText,
  minuteText,
  TABLE_PLATFORMS,
  TABLE_SIZES,
  type TablePlatform,
  type TableSize,
} from "@relayrunner/providers/runner-table";

export interface TableRow extends RunnerTableRow {
  href: string;
  logo: string;
}

/** Every priced provider, by name. */
export const TABLE_ROWS: TableRow[] = RUNNER_TABLE_ROWS.map((row) => ({
  ...row,
  href: integrationPath(row.id as IntegrationId),
  logo: `/providers/${row.id}.svg`,
}));

/** Providers the table can't price per runner, and why. */
export const UNPRICED_ROWS = UNPRICED_TABLE_ROWS.map((row) => ({
  ...row,
  id: row.id as IntegrationId,
}));

/** The runner clouds the featured cards above the table show. */
export const FEATURED: IntegrationId[] = [
  "github",
  "blacksmith",
  "depot",
  "boat",
  "ubicloud",
  "namespace",
];

/** Each featured card: logo, name, entry plan and the list price of a 2 vCPU Linux x64 minute. */
export const FEATURED_TILES = FEATURED.map((id) => {
  const entry = entryPlan(id);
  const cell = RUNNER_TABLE_ROWS.find((row) => row.id === id)?.cells[cellKey("linux", 2)];
  return {
    id,
    name: PROVIDERS[id].name,
    href: integrationPath(id),
    logo: `/providers/${id}.svg`,
    plan: id === "github" ? "Free with GitHub" : (entry?.plan ?? "—"),
    price: cell ? `${minuteText(cell.usd)}/min` : undefined,
    // A provider without one per-minute price says why instead, so every card has the same lines.
    priceNote: UNPRICED_TABLE_ROWS.find((row) => row.id === id)?.why,
  };
});
