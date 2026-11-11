/**
 * Operator admin for runner prices: each provider rate's price history, base list and recorded
 * rows together, and adding or removing recorded rows (provider_price). Needs Cloudflare Access
 * (app.ts) and an operator session (admin.ts). A change applies to reports at once, with no deploy.
 */
import { dayMs, isRate, type PricedProvider, RATES } from "@relayrunner/providers";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { who } from "../middleware/admin.ts";
import { forgetPriceBook, readPriceBook } from "../prices.ts";

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

// A price row change, for the audit log.
function logPrice(
  c: Context<AppEnv>,
  msg: string,
  row: { provider: string; rate: string; usd: number; from: string },
) {
  const { provider, rate, usd, from } = row;
  console.log(
    JSON.stringify({
      msg,
      by: c.var.user!.email,
      access: who(c.var.accessIdentity),
      provider,
      rate,
      usd,
      from,
    }),
  );
}

// Mounted under adminRoutes, which requires an operator session.
export const adminPriceRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    // Read fresh, so the page shows what was just added.
    const book = await readPriceBook(createDb(c.env.DB));
    const now = Date.now();
    const rates: AdminRate[] = Object.entries(RATES).flatMap(([provider, rates]) =>
      Object.entries(rates).map(([rate, per]) => ({
        provider: provider as PricedProvider,
        rate,
        per,
        current: book.usd(provider, rate, now),
        rows: book.history(provider, rate).map(({ id, usd, from, source, createdBy }) => ({
          id: id ?? null,
          usd,
          from,
          source: source ?? null,
          createdBy: createdBy ?? null,
        })),
      })),
    );
    return c.json({ rates });
  })
  .post("/", async (c) => {
    const parsed = PriceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_price" }, 400);
    const { provider, rate, usd, from, source } = parsed.data;
    if (!isRate(provider, rate)) return c.json({ error: "unknown_rate" }, 400);
    const [row] = await createDb(c.env.DB)
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
    logPrice(c, "provider price recorded", row);
    return c.json({ price: row }, 201);
  })
  .delete("/:id", async (c) => {
    const [row] = await createDb(c.env.DB)
      .delete(schema.providerPrice)
      .where(eq(schema.providerPrice.id, c.req.param("id")))
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    forgetPriceBook();
    logPrice(c, "provider price removed", row);
    return c.json({ ok: true });
  });
