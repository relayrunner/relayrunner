// /openapi.json: the agent API's OpenAPI description (src/lib/openapi.ts).
import type { APIRoute } from "astro";
import { openApi } from "../lib/openapi";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(openApi, null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
