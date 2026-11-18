import { defineConfig } from "drizzle-kit";

// Only generates SQL into ./migrations. Wrangler applies it locally (`pnpm db:migrate:local`) and
// cf in production (`pnpm db:migrate:remote`).
// Timestamp prefixes (YYYYMMDDHHMMSS_name.sql) so migrations written on parallel branches
// don't collide on the same counter. Don't use `cf`/`wrangler d1 migrations create`: they number them.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  migrations: { prefix: "timestamp" },
});
