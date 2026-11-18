// The runner table on /integrations. Its rows come from @relayrunner/providers/runner-table, the same
// table the dashboard's Providers page shows; this adds the site's links and logos and the featured strip.
import { PROVIDERS } from "@relayrunner/providers";
import {
  entryPlan,
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

/** "3,000 min a month" as "3,000 min/mo" and "$20 a month" as "$20/mo", for the featured strip. */
const shortIncluded = (text: string) =>
  text.replace(" min a month", " min/mo").replace(" a month", "/mo");

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

/** The runner clouds the strip above the table features. */
export const FEATURED: IntegrationId[] = ["blacksmith", "depot", "boat", "ubicloud"];

export const FEATURED_TILES = FEATURED.map((id) => {
  const entry = entryPlan(id);
  return {
    id,
    name: PROVIDERS[id].name,
    href: integrationPath(id),
    logo: `/providers/${id}.svg`,
    plan: id === "github" ? "Free with GitHub" : (entry?.plan ?? "—"),
    included: entry ? shortIncluded(entry.included) : "—",
  };
});
