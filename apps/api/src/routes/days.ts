import { z } from "zod";

const DaysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

/** A report's ?days=N (1 to 90, default 30), or null when it isn't one. */
export function parseDays(query: Record<string, string>) {
  const parsed = DaysQuery.safeParse(query);
  return parsed.success ? parsed.data.days : null;
}
