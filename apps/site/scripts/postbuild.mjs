// Adds the files that belong at the asset root after `astro build`:
// - _redirects: /docs goes to the first page, Overview, since there is no docs home page. Pages
//   that moved keep their old URLs working, with or without a trailing slash. Other trailing
//   slashes are dropped by the asset server (html_handling in wrangler.jsonc). /sitemap.xml, where
//   crawlers look first, goes to the sitemap index. The older well-known MCP card paths go to the
//   server's own card (apps/agents/src/server-card.ts); /.well-known/ai-catalog.json points there too.
//   /mac/download goes to the newest Mac app DMG, read from the Sparkle feed release.sh writes, so
//   download links never name a version. /mac goes to the Mac app's docs page.
// - _headers: long-lived caching for Astro's hashed files in /_astro/ (CSS, JS, fonts). Without
//   it every page load revalidates the fonts, and text paints in the fallback font first. The
//   machine-readable files agents fetch get their media types and open CORS, since any page may
//   read them.
import { readFileSync, writeFileSync } from "node:fs";

// The feed's enclosure is the zip Sparkle installs; the DMG sits next to it in the same release.
const appcast = readFileSync(new URL("../public/mac/appcast.xml", import.meta.url), "utf8");
const macZip = appcast.match(/<enclosure url="([^"]+\.zip)"/)?.[1];
if (!macZip) throw new Error("public/mac/appcast.xml has no .zip enclosure to find the DMG from");
const macDmg = macZip.replace(/\.zip$/, ".dmg");

writeFileSync(
  new URL("../dist/_redirects", import.meta.url),
  [
    "/docs /docs/get-started/overview 302",
    "/docs/ /docs/get-started/overview 302",
    "/docs/ci/routing /docs/concepts/routing 301",
    "/docs/ci/routing/ /docs/concepts/routing 301",
    "/docs/ci/free-checks /docs/concepts/optimized-checks 301",
    "/docs/ci/free-checks/ /docs/concepts/optimized-checks 301",
    "/docs/concepts/free-checks /docs/concepts/optimized-checks 301",
    "/docs/concepts/free-checks/ /docs/concepts/optimized-checks 301",
    "/docs/guides/stay-under-quota /docs/guides/spend-controls 301",
    "/docs/guides/stay-under-quota/ /docs/guides/spend-controls 301",
    "/sitemap.xml /sitemap-index.xml 301",
    "/mac /docs/get-started/mac-app 302",
    `/mac/download ${macDmg} 302`,
    "/.well-known/mcp.json https://agents.relayrunner.app/mcp/server-card 302",
    "/.well-known/mcp/server-card.json https://agents.relayrunner.app/mcp/server-card 302",
    "",
  ].join("\n"),
);

writeFileSync(
  new URL("../dist/_headers", import.meta.url),
  [
    "/_astro/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/.well-known/ai-catalog.json",
    "  Content-Type: application/ai-catalog+json",
    "  Access-Control-Allow-Origin: *",
    "/.well-known/releases.json",
    "  Access-Control-Allow-Origin: *",
    "/changelog.xml",
    "  Content-Type: application/rss+xml; charset=utf-8",
    "  Access-Control-Allow-Origin: *",
    "/openapi.json",
    "  Access-Control-Allow-Origin: *",
    "/llms.txt",
    "  Access-Control-Allow-Origin: *",
    "/setup.md",
    "  Access-Control-Allow-Origin: *",
    "/skills/*",
    "  Access-Control-Allow-Origin: *",
    "",
  ].join("\n"),
);
