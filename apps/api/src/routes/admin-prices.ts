/**
 * Operator admin for runner prices: each provider rate's price history, base list and recorded
 * rows together, and adding or removing recorded rows (provider_price). Needs Cloudflare Access
 * (app.ts) and an operator session. A change applies to reports at once, with no deploy.
 */
import { BASE_PRICES, dayMs, isRate, type PricedProvider, RATES } from "@relayrunner/providers";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { requireOperator, who } from "../middleware/admin.ts";
import { requireUser } from "../middleware/session.ts";
import { forgetPriceBook, loadPriceBook, recordedPrices } from "../prices.ts";

const PriceBody = z.object({
  provider: z.string(),
  rate: z.string(),
  // USD for a minute; anything near a dollar is a typo.
  usd: z.number().positive().max(1),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((day) => !Number.isNaN(dayMs(day))),
  source: z.string().trim().max(500).optional(),
});

export interface AdminPriceRow {
  /** Null for a base-list row, which changes in code. */
  id: string | null;
  usd: number;
  from: string;
  source: string | null;
  createdBy: string | null;
}

export interface AdminRate {
  provider: PricedProvider;
  rate: string;
  /** What a minute is per: one vCPU, or the whole runner. */
  per: "vcpu" | "runner";
  /** USD for a minute today. */
  current: number | null;
  /** Oldest first. */
  rows: AdminPriceRow[];
}

export const adminPriceRoutes = new Hono<AppEnv>()
  .use("*", requireUser, requireOperator)
  .get("/", async (c) => {
    const db = createDb(c.env.DB);
    const [book, recorded] = await Promise.all([loadPriceBook(db), recordedPrices(db)]);
    const rates: AdminRate[] = Object.entries(RATES).flatMap(([provider, rates]) =>
      Object.entries(rates).map(([rate, per]) => {
        const matches = (row: { provider: string; rate: string }) =>
          row.provider === provider && row.rate === rate;
        const rows: AdminPriceRow[] = [
          ...BASE_PRICES.filter(matches).map((row) => ({
            id: null,
            usd: row.usd,
            from: row.from,
            source: null,
            createdBy: null,
          })),
          ...recorded.filter(matches).map(({ id, usd, from, source, createdBy }) => ({
            id,
            usd,
            from,
            source,
            createdBy,
          })),
        ].sort((a, b) => a.from.localeCompare(b.from));
        const p = provider as PricedProvider;
        return { provider: p, rate, per, current: book.usd(p, rate, Date.now()) ?? null, rows };
      }),
    );
    return c.json({ rates });
  })
  .post("/", async (c) => {
    const parsed = PriceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_price" }, 400);
    const { provider, rate, usd, from, source } = parsed.data;
    if (!isRate(provider, rate)) return c.json({ error: "unknown_rate" }, 400);
    const db = createDb(c.env.DB);
    const [row] = await db
      .insert(schema.providerPrice)
      .values({
        id: crypto.randomUUID(),
        provider,
        rate,
        usd,
        from,
        source: source || null,
        createdBy: c.var.user!.email,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return c.json({ error: "price_exists" }, 409);
    forgetPriceBook();
    console.log(
      JSON.stringify({
        msg: "provider price recorded",
        by: c.var.user!.email,
        access: who(c.var.accessIdentity),
        provider,
        rate,
        usd,
        from,
      }),
    );
    return c.json({ price: row }, 201);
  })
  .delete("/:id", async (c) => {
    const [row] = await createDb(c.env.DB)
      .delete(schema.providerPrice)
      .where(eq(schema.providerPrice.id, c.req.param("id")))
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    forgetPriceBook();
    console.log(
      JSON.stringify({
        msg: "provider price removed",
        by: c.var.user!.email,
        access: who(c.var.accessIdentity),
        provider: row.provider,
        rate: row.rate,
        usd: row.usd,
        from: row.from,
      }),
    );
    return c.json({ ok: true });
  });
