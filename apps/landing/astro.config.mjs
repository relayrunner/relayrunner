// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  // One site: the landing pages (src/pages/*.astro) at /, the docs at /docs/. The canonical and
  // share-image tags need an absolute origin; SITE_URL overrides it for preview builds.
  site: process.env.SITE_URL ?? "https://relayrunner.app",
  // Keep the landing HTML's whitespace as written. Astro's default compression drops the line break
  // between text and an inline link wrapped onto its own line ("Or<a>copy one line</a>into").
  compressHTML: false,
  // There is no base: Starlight serves docs from src/content/docs/docs/, so they land at /docs/.
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "RelayRunner Docs",
      // The header logo is the site favicon, not a separate copy.
      logo: { src: "./public/favicon.png", alt: "RelayRunner" },
      favicon: "/favicon.png",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/relayrunner/relayrunner" },
      ],
      customCss: [
        "@fontsource-variable/hanken-grotesk",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/theme.css",
      ],
      // Sidebar order is set here: add a page's slug to its section when you add the file.
      sidebar: [
        {
          label: "Get started",
          items: [
            "docs/get-started/overview",
            "docs/get-started/quickstart",
            "docs/get-started/install",
            "docs/get-started/agents",
          ],
        },
        { label: "CI", items: ["docs/ci/routing", "docs/ci/free-checks"] },
        {
          label: "Runners",
          items: ["docs/runners/self-hosted", "docs/runners/github", "docs/runners/blacksmith"],
        },
        {
          label: "Reference",
          items: [
            "docs/reference/cli",
            "docs/reference/relay-inputs",
            "docs/reference/security",
            "docs/reference/troubleshooting",
          ],
        },
      ],
      // Flat, non-collapsing sidebar, and the page title with its description under it.
      components: {
        Sidebar: "./src/components/Sidebar.astro",
        PageTitle: "./src/components/PageTitle.astro",
        Head: "./src/components/Head.astro",
        Pagination: "./src/components/Pagination.astro",
      },
    }),
  ],
});
