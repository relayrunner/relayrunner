import type { SpendUsage } from "./events.ts";

/** "$1,250": whole dollars, as spend limits are set. */
export const dollars = (usd: number) => `$${Math.round(usd).toLocaleString("en-US")}`;

/** "acme has spent $212 on Depot this month, past its $200 limit", for a spend_limit skip. */
export function spendText(provider: string, spend: SpendUsage | undefined): string {
  if (!spend) return `${provider} is past its spend limit`;
  const { account, spentUsd, limitUsd } = spend;
  return `${account} has spent ${dollars(spentUsd)} on ${provider} this month, past its ${dollars(limitUsd)} limit`;
}
