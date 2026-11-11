/**
 * Operator admin for runner prices: each provider rate's price history, base list and recorded
 * rows together, and adding or removing recorded rows (provider_price). Needs Cloudflare Access
 * (app.ts) and an operator session (admin.ts). A change applies to reports at once, with no deploy.
 * Prices the daily check finds (price-check.ts, price_finding) wait here until an operator approves
 * one into provider_price or dismisses it.
 */
import { dayMs, isRate, type PricedProvider, RATES } from "@relayrunner/providers";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { who } from "../middleware/admin.ts";
import { checkPrices } from "../price-check.ts";
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

/** A price the daily check found, waiting for an operator. */
export interface PendingPrice {
  id: string;
  provider: PricedProvider;
  rate: string;
  per: "vcpu" | "runner";
  usd: number;
  from: string;
  source: string | null;
  /** What jobs are priced at on that day now. */
  current: number | null;
}

/** The price check's last run on one provider's page. */
export interface PriceCheckStatus {
  provider: string;
  checkedAt: string;
  error: string | null;
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

// Records a price row; null when the rate already has one from that day.
async function recordPrice(
  c: Context<AppEnv>,
  price: { provider: string; rate: string; usd: number; from: string; source: string | null },
) {
  const [row] = await createDb(c.env.DB)
    .insert(schema.providerPrice)
    .values({ id: crypto.randomUUID(), ...price, createdBy: c.var.user!.email })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  forgetPriceBook();
  logPrice(c, "provider price recorded", row);
  return row;
}

// Mounted under adminRoutes, which requires an operator session.
export const adminPriceRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    // Read fresh, so the page shows what was just added.
    const db = createDb(c.env.DB);
    const [book, pendingRows, checks] = await Promise.all([
      readPriceBook(db),
      db
        .select()
        .from(schema.priceFinding)
        .where(isNull(schema.priceFinding.dismissedAt))
        .orderBy(
          asc(schema.priceFinding.provider),
          asc(schema.priceFinding.rate),
          asc(schema.priceFinding.from),
        ),
      db.select().from(schema.priceCheck).orderBy(asc(schema.priceCheck.provider)),
    ]);
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
    const pending: PendingPrice[] = pendingRows
      .filter((row) => isRate(row.provider, row.rate))
      .map(({ id, provider, rate, usd, from, source }) => ({
        id,
        provider: provider as PricedProvider,
        rate,
        per: RATES[provider as PricedProvider][rate as never],
        usd,
        from,
        source,
        current: book.usd(provider, rate, Math.min(dayMs(from), now)),
      }));
    const checked: PriceCheckStatus[] = checks.map(({ provider, checkedAt, error }) => ({
      provider,
      checkedAt: checkedAt.toISOString(),
      error,
    }));
    return c.json({ rates, pending, checks: checked });
  })
  // Runs the daily price check now.
  .post("/check", async (c) => {
    console.log(JSON.stringify({ msg: "price check run by hand", by: c.var.user!.email }));
    await checkPrices(c.env);
    return c.json({ ok: true });
  })
  .post("/:id/approve", async (c) => {
    const db = createDb(c.env.DB);
    const finding = await db.query.priceFinding.findFirst({
      where: and(
        eq(schema.priceFinding.id, c.req.param("id")),
        isNull(schema.priceFinding.dismissedAt),
      ),
    });
    if (!finding) return c.json({ error: "not_found" }, 404);
    const { provider, rate, usd, from, source } = finding;
    const row = await recordPrice(c, { provider, rate, usd, from, source });
    if (!row) return c.json({ error: "price_exists" }, 409);
    await db.delete(schema.priceFinding).where(eq(schema.priceFinding.id, finding.id));
    return c.json({ price: row });
  })
  // Kept, so the check doesn't raise the same price again.
  .post("/:id/dismiss", async (c) => {
    const [row] = await createDb(c.env.DB)
      .update(schema.priceFinding)
      .set({ dismissedAt: new Date() })
      .where(
        and(eq(schema.priceFinding.id, c.req.param("id")), isNull(schema.priceFinding.dismissedAt)),
      )
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    logPrice(c, "price finding dismissed", row);
    return c.json({ ok: true });
  })
  .post("/", async (c) => {
    const parsed = PriceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_price" }, 400);
    const { provider, rate, usd, from, source } = parsed.data;
    if (!isRate(provider, rate)) return c.json({ error: "unknown_rate" }, 400);
    const row = await recordPrice(c, { provider, rate, usd, from, source: source || null });
    if (!row) return c.json({ error: "price_exists" }, 409);
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
