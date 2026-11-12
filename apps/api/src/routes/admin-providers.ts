/**
 * Operator admin for providers: the code list with operators' rows on top (provider-catalog.ts),
 * editing any provider's text and links, and adding providers by their label prefixes. Needs
 * Cloudflare Access (app.ts) and an operator session (admin.ts). A change applies at once, with no
 * deploy. Removing a row puts a provider in code back as it was, or removes an added one.
 */
import { isProviderId } from "@relayrunner/providers";
import { prefixProblem, providerIdProblem } from "@relayrunner/providers/catalog";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { createDb, schema } from "../db/index.ts";
import { who } from "../middleware/admin.ts";
import { forgetCatalog, readCatalog } from "../provider-catalog.ts";

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
  logoUrl: url,
});

const NewProviderBody = ProviderBody.extend({ id: z.string().trim().toLowerCase() });

type ProviderFields = z.infer<typeof ProviderBody>;

// A provider change, for the audit log.
const audit = (c: Context<AppEnv>, msg: string, id: string) =>
  console.log(
    JSON.stringify({ msg, by: c.var.user!.email, access: who(c.var.accessIdentity), id }),
  );

// Saves a provider's row, replacing any it had, and logs who did it.
async function save(c: Context<AppEnv>, id: string, fields: ProviderFields, msg: string) {
  const values = {
    ...fields,
    // Providers in code keep their matching in code.
    prefixes: isProviderId(id) ? [] : fields.prefixes,
    logoUrl: isProviderId(id) ? null : fields.logoUrl,
    updatedBy: c.var.user!.email,
    updatedAt: new Date(),
  };
  await createDb(c.env.DB)
    .insert(schema.provider)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: schema.provider.id, set: values });
  forgetCatalog();
  audit(c, msg, id);
}

// Mounted under adminRoutes, which requires an operator session.
export const adminProviderRoutes = new Hono<AppEnv>()
  // Read fresh, so the page shows what was just saved.
  .get("/", async (c) => c.json({ providers: await readCatalog(createDb(c.env.DB)) }))
  .post("/", async (c) => {
    const parsed = NewProviderBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_provider" }, 400);
    const { id, ...fields } = parsed.data;
    const catalog = await readCatalog(createDb(c.env.DB));
    const problem = providerIdProblem(catalog, id) ?? prefixProblem(catalog, id, fields.prefixes);
    if (problem) return c.json({ error: problem }, problem === "provider_exists" ? 409 : 400);
    await save(c, id, fields, "provider added");
    return c.json({ ok: true }, 201);
  })
  .put("/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = ProviderBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_provider" }, 400);
    const catalog = await readCatalog(createDb(c.env.DB));
    if (!catalog.some((provider) => provider.id === id)) return c.json({ error: "not_found" }, 404);
    if (!isProviderId(id)) {
      const problem = prefixProblem(catalog, id, parsed.data.prefixes);
      if (problem) return c.json({ error: problem }, 400);
    }
    await save(c, id, parsed.data, "provider saved");
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await createDb(c.env.DB)
      .delete(schema.provider)
      .where(eq(schema.provider.id, id))
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    forgetCatalog();
    audit(c, isProviderId(id) ? "provider reset" : "provider removed", id);
    return c.json({ ok: true });
  });
