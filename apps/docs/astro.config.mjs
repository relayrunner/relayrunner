// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  // Production origin. Move to relayrunner.app (and later relayrunner.dev) when the docs join the
  // landing site.
  site: "https://relayrunner-docs.relayrun.workers.dev",
  // Pages are served under /docs and built into dist/docs/, so URLs already match their future
  // home at relayrunner.app/docs. scripts/postbuild.mjs redirects / to /docs/.
  base: "/docs",
  outDir: "./dist/docs",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "RelayRunner Docs",
      logo: { src: "./src/assets/logo.png", alt: "RelayRunner" },
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
            "get-started/how-it-works",
            "get-started/quickstart",
            "get-started/install",
            "get-started/agents",
          ],
        },
        { label: "CI", items: ["ci/routing", "ci/free-checks"] },
        {
          label: "Runners",
          items: ["runners/self-hosted", "runners/github", "runners/blacksmith"],
        },
        {
          label: "Reference",
          items: [
            "reference/cli",
            "reference/relay-inputs",
            "reference/security",
            "reference/troubleshooting",
          ],
        },
      ],
      // Flat, non-collapsing sidebar (src/components/Sidebar.astro).
      components: { Sidebar: "./src/components/Sidebar.astro" },
      editLink: {
        baseUrl: "https://github.com/relayrunner/relayrunner/edit/main/apps/docs/",
      },
      lastUpdated: true,
    }),
  ],
});
