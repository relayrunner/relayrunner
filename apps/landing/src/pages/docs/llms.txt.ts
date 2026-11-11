import type { APIRoute } from "astro";
import { docsEntries, llmsIndex } from "../../lib/agent-docs";

export const GET: APIRoute = async ({ site }) =>
  new Response(llmsIndex(await docsEntries(), site!), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
