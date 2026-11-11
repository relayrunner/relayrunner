import type { APIRoute } from "astro";
import { docsEntries, llmsFull } from "../lib/agent-docs";

export const GET: APIRoute = async () =>
  new Response(llmsFull(await docsEntries()), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
