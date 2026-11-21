import type { SpendUsage, StartLimit } from "./events.ts";

/** "$1,250": whole dollars, as spend limits are set. */
export const dollars = (usd: number) => `$${Math.round(usd).toLocaleString("en-US")}`;

/** "acme has spent $212 on Depot this month, past its $200 limit", for a spend_limit skip. */
export function spendText(provider: string, spend: SpendUsage | undefined): string {
  if (!spend) return `${provider} is past its spend limit`;
  const { account, spentUsd, limitUsd } = spend;
  return `${account} has spent ${dollars(spentUsd)} on ${provider} this month, past its ${dollars(limitUsd)} limit`;
}

const PER_WINDOW = { minute: "a minute", hour: "an hour", day: "a day" } as const;

/** "60 an hour": a plan's start limit for a window. */
export const startsPerWindow = ({ window, limit }: StartLimit) =>
  limit === null ? `its ${window} limit` : `${limit.toLocaleString("en-US")} ${PER_WINDOW[window]}`;

/** "Boat has used all the job starts its plan allows (60 an hour)", for a start_limit skip. */
export function startLimitText(provider: string, starts: StartLimit | undefined): string {
  if (!starts) return `${provider} has used all the job starts its plan allows`;
  return `${provider} has used all the job starts its plan allows (${startsPerWindow(starts)})`;
}
