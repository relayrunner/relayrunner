// /.well-known/ai-catalog.json: where agents find the MCP server (the AI Catalog format MCP Server
// Cards use for domain-level discovery). The card itself lives with the server, at
// SERVER_CARD_URL (apps/agents/src/server-card.ts). Its media type is set in _headers
// (scripts/postbuild.mjs), since a static build drops a page's response headers.
import type { APIRoute } from "astro";
import { SERVER_CARD_URL } from "../../lib/mcp";

export const GET: APIRoute = () =>
  new Response(
    `${JSON.stringify(
      {
        specVersion: "1.0",
        entries: [
          {
            identifier: "urn:air:relayrunner.app:mcp:relayrunner",
            type: "application/mcp-server-card+json",
            url: SERVER_CARD_URL,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
