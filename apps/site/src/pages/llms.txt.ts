import type { APIRoute } from "astro";
import { docsEntries, llmsIndex } from "../lib/agent-docs";

// /llms.txt at the root, where agents look first. /docs/llms.txt serves the same file.
export const GET: APIRoute = async ({ site }) =>
  new Response(llmsIndex(await docsEntries(), site!), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
