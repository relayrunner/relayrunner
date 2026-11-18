import { defineConfig } from "drizzle-kit";

// Only generates SQL into ./migrations. Wrangler applies it: `pnpm db:migrate:local`.
// Timestamp prefixes (YYYYMMDDHHMMSS_name.sql) so migrations written on parallel branches
// don't collide on the same counter. Don't use `wrangler d1 migrations create`: it numbers them.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  migrations: { prefix: "timestamp" },
});
