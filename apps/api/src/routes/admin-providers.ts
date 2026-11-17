/**
 * Operator admin for providers: the code list with operators' rows on top (provider-catalog.ts),
 * editing any provider's text and links, and adding providers by their label prefixes. Needs
 * Cloudflare Access (app.ts) and an operator session (admin.ts). A change applies at once, with no
 * deploy. Removing a row puts a provider in code back as it was, or removes an added one. Status
 * and Featured decide what the Providers page offers; a new provider starts Hidden.
 */
import { isProviderId, PLATFORMS } from "@relayrunner/providers";
import {
  type CatalogProvider,
  FIXED_STATUS,
  PROVIDER_STATUSES,
  prefixProblem,
  providerIdProblem,
} from "@relayrunner/providers/catalog";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { audit } from "../middleware/admin.ts";
import { forgetCatalog, readCatalog } from "../provider-catalog.ts";
import { AppError } from "@relayrunner/errors";

const text = (max: number) => z.string().trim().min(1).max(max);
// Blank or left out is null.
const optional = (field: z.ZodType<string>) => field.nullish().transform((value) => value || null);
const optionalText = (max: number) => optional(z.string().trim().max(max));
const url = optional(
  z
    .string()
    .trim()
    .max(500)
    .refine((value) => !value || value.startsWith("https://")),
);
// Or one of the logos the dashboard serves itself (apps/web/public/provider-logos).
const logoUrl = optional(
  z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) =>
        !value || value.startsWith("https://") || /^\/provider-logos\/[a-z0-9.-]+$/.test(value),
    ),
);
const status = z.enum(PROVIDER_STATUSES);
const price = z
  .number()
  .min(0)
  .max(10_000)
  .nullish()
  .transform((value) => value ?? null);

const ProviderBody = z.object({
  name: text(60),
  summary: text(200),
  labels: text(200),
  prefixes: z
    .array(z.string().trim().toLowerCase())
    .max(10)
    .transform((list) => [...new Set(list.filter(Boolean))])
    .default([]),
  example: optionalText(200),
  setup: optionalText(500),
  dashboardUrl: url,
  docsUrl: url,
  logoUrl,
  // Left out: a new provider starts Hidden, and a saved one keeps what it had.
  status: status.optional(),
  featured: z.boolean().optional(),
  platforms: z
    .array(z.enum(PLATFORMS))
    .max(PLATFORMS.length)
    .nullish()
    .transform((list) => (list?.length ? [...new Set(list)] : null)),
  feeUsd: price,
  perMinute: price,
  connectUrl: url,
});

const NewProviderBody = ProviderBody.extend({ id: z.string().trim().toLowerCase() });

// What the table changes in place.
const ProviderFlags = z
  .object({ status: status.optional(), featured: z.boolean().optional() })
  .refine((body) => body.status !== undefined || body.featured !== undefined);

type ProviderFields = Omit<z.infer<typeof ProviderBody>, "status" | "featured"> & {
  status: (typeof PROVIDER_STATUSES)[number];
  /** Null keeps the code's choice for a provider in code. */
  featured: boolean | null;
};

// Saves a provider's row, replacing any it had, and logs who did it.
async function save(c: Context<AppEnv>, id: string, fields: ProviderFields, msg: string) {
  const values = {
    ...fields,
    // Providers in code keep their matching in code, and can't be turned off: code matches their
    // labels in more places than the list.
    prefixes: isProviderId(id) ? [] : fields.prefixes,
    logoUrl: isProviderId(id) ? null : fields.logoUrl,
    status: FIXED_STATUS.has(id)
      ? ("live" as const)
      : isProviderId(id) && fields.status === "off"
        ? ("hidden" as const)
        : fields.status,
    updatedBy: c.var.user!.email,
    updatedAt: new Date(),
  };
  await createDb(c.env.DB)
    .insert(schema.provider)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: schema.provider.id, set: values });
  forgetCatalog();
  audit(c, msg, { id, status: values.status });
}

// A provider's fields as saved now, so a status change can keep the rest.
const fieldsOf = (provider: CatalogProvider): ProviderFields => ({
  name: provider.name,
  summary: provider.summary,
  labels: provider.labels,
  prefixes: provider.prefixes,
  example: provider.example ?? null,
  setup: provider.setup ?? null,
  dashboardUrl: provider.dashboardUrl ?? null,
  docsUrl: provider.docsUrl ?? null,
  logoUrl: provider.logoUrl ?? null,
  status: provider.status,
  // A provider in code keeps following the code until someone changes Featured.
  featured: provider.builtIn && !provider.updatedBy ? null : provider.featured,
  platforms: provider.platforms ?? null,
  feeUsd: provider.feeUsd ?? null,
  perMinute: provider.perMinute ?? null,
  connectUrl: provider.connectUrl ?? null,
});

// Mounted under adminRoutes, which requires an operator session.
export const adminProviderRoutes = new Hono<AppEnv>()
  // Read fresh, so the page shows what was just saved.
  .get("/", async (c) => c.json({ providers: await readCatalog(createDb(c.env.DB)) }))
  .post("/", async (c) => {
    const parsed = NewProviderBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("PROVIDER_INVALID");
    const { id, status = "hidden", featured = false, ...fields } = parsed.data;
    const catalog = await readCatalog(createDb(c.env.DB));
    const problem = providerIdProblem(catalog, id) ?? prefixProblem(catalog, id, fields.prefixes);
    if (problem) throw new AppError(problem);
    await save(c, id, { ...fields, status, featured }, "provider added");
    return c.json({ ok: true }, 201);
  })
  .put("/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = ProviderBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("PROVIDER_INVALID");
    const catalog = await readCatalog(createDb(c.env.DB));
    const provider = catalog.find((p) => p.id === id);
    if (!provider) throw new AppError("NOT_FOUND");
    if (!isProviderId(id)) {
      const problem = prefixProblem(catalog, id, parsed.data.prefixes);
      if (problem) throw new AppError(problem);
    }
    const kept = fieldsOf(provider);
    const { status = kept.status, featured = kept.featured, ...fields } = parsed.data;
    await save(c, id, { ...fields, status, featured }, "provider saved");
    return c.json({ ok: true });
  })
  // Status and Featured, from the table.
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = ProviderFlags.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError("PROVIDER_INVALID");
    const provider = (await readCatalog(createDb(c.env.DB))).find((p) => p.id === id);
    if (!provider) throw new AppError("NOT_FOUND");
    const { status, featured } = parsed.data;
    const fields = fieldsOf(provider);
    await save(
      c,
      id,
      { ...fields, status: status ?? fields.status, featured: featured ?? fields.featured },
      status ? `provider ${status}` : featured ? "provider featured" : "provider unfeatured",
    );
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await createDb(c.env.DB)
      .delete(schema.provider)
      .where(eq(schema.provider.id, id))
      .returning();
    if (!row) throw new AppError("NOT_FOUND");
    forgetCatalog();
    audit(c, isProviderId(id) ? "provider reset" : "provider removed", { id });
    return c.json({ ok: true });
  });
