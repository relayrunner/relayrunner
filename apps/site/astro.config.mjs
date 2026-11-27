// @ts-check
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { lastModified } from "./scripts/lastmod.mjs";
import { SIDEBAR } from "./src/lib/sidebar.mjs";

const lastmod = lastModified();

export default defineConfig({
  // One site: the landing pages (src/pages/*.astro) at /, the docs at /docs/. The canonical and
  // share-image tags need an absolute origin; SITE_URL overrides it for preview builds.
  site: process.env.SITE_URL ?? "https://relayrunner.dev",
  // Keep the landing HTML's whitespace as written. Astro's default compression drops the line break
  // between text and an inline link wrapped onto its own line ("Or<a>copy one line</a>into").
  compressHTML: false,
  // There is no base: Starlight serves docs from src/content/docs/docs/, so they land at /docs.
  // URLs have no trailing slash. Pages still build to <path>/index.html; the asset server serves
  // them at <path> and redirects <path>/ there (html_handling in wrangler.jsonc).
  trailingSlash: "never",
  // /docs has no page of its own: send it to the first one, so header and app links can say /docs.
  redirects: {
    "/docs": "/docs/get-started/overview",
    "/changelog": "/docs/changelog",
    "/docs/runners/blacksmith": "/docs/runners/hosted",
    "/docs/contribute/for-providers": "/docs/providers/get-listed",
    "/docs/contribute/add-provider": "/docs/providers/get-listed",
    "/docs/contribute/publish-prices": "/docs/providers/publish-prices",
  },
  // Fetch a page when its link is hovered or focused, so moving between docs pages is near instant.
  prefetch: { prefetchAll: true },
  integrations: [
    // Starlight would add a bare sitemap on its own; this one adds each page's last change date.
    // It lists every built page (redirects and the 404 page excluded), so new pages need no edits.
    // robots.txt (src/pages/robots.txt.ts) points crawlers at it.
    sitemap({
      serialize: (item) => ({ ...item, lastmod: lastmod(item.url) }),
    }),
    starlight({
      title: "RelayRunner Docs",
      // The header logo is the site favicon, not a separate copy.
      logo: { src: "./public/favicon.png", alt: "RelayRunner" },
      favicon: "/favicon.png",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/relayrunner/relayrunner" },
        { icon: "x.com", label: "RelayRunner on X", href: "https://x.com/relayrunnerCI" },
      ],
      customCss: [
        // Landing tokens (and its fonts) and the shared header, then the Starlight theme.
        "./src/styles/tokens.css",
        "./src/styles/header.css",
        "./src/styles/theme.css",
        "./src/styles/transitions.css",
      ],
      // Sidebar order lives in src/lib/sidebar.mjs, shared with llms.txt and llms-full.txt.
      sidebar: SIDEBAR,
      // Put the code block styles inline in each page. By default they're a separate stylesheet
      // linked from the first code block, in the body, so a page change paints the header first
      // and the rest only once that file arrives: on pages with code, the docs blinked.
      expressiveCode: { emitExternalStylesheet: false },
      // Flat sidebar with collapsible groups, and the page title with its description under it.
      components: {
        Sidebar: "./src/components/Sidebar.astro",
        PageTitle: "./src/components/PageTitle.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        Pagination: "./src/components/Pagination.astro",
      },
    }),
  ],
});
