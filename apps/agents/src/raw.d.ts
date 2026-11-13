// Wrangler bundles `.md` files as strings (the Text rule in wrangler.jsonc), and so do tests
// (vitest.config.ts).
declare module "*.md" {
  const text: string;
  export default text;
}

// Vite's import.meta.glob, which skills.test.ts uses to read skills/.
interface ImportMeta {
  glob(
    patterns: string | string[],
    options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
}
