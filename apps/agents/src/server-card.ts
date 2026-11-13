/**
 * The MCP Server Card for this server (the MCP Server Cards extension, SEP-2127): who it is and
 * where to connect, for clients that look before they connect. This Worker serves it at
 * /mcp/server-card, the location MCP reserves for it. The site lists it in
 * https://relayrunner.app/.well-known/ai-catalog.json and redirects the older well-known card paths
 * here. It names no tools: clients list those
 * after signing in.
 */
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";

/** Also the version the server reports when a client connects (index.ts). */
export const SERVER_VERSION = "0.1.0";

export const SERVER_CARD_TYPE = "application/mcp-server-card+json";

export const serverCard = (mcpUrl: string) => ({
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: "app.relayrunner/mcp",
  version: SERVER_VERSION,
  title: "RelayRunner",
  description: "Read your RelayRunner workspace: runners, workflow runs, routing and CI usage.",
  websiteUrl: "https://relayrunner.app/docs/reference/mcp",
  repository: {
    url: "https://github.com/relayrunner/relayrunner",
    source: "github",
    subfolder: "apps/agents",
  },
  icons: [{ src: "https://relayrunner.app/favicon.png", mimeType: "image/png", sizes: ["64x64"] }],
  remotes: [
    {
      type: "streamable-http",
      url: mcpUrl,
      // The SDK's list holds the 2025-era revisions; index.ts serves 2026-07-28 next to them.
      supportedProtocolVersions: ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS],
    },
  ],
});
