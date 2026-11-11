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
      // Each folder under src/content/docs/ is a sidebar group; pages sort by `sidebar.order`
      // in their frontmatter, then by title.
      sidebar: [
        {
          label: "Getting started",
          items: [
            { slug: "index", label: "Introduction" },
            { autogenerate: { directory: "getting-started" } },
          ],
        },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
      editLink: {
        baseUrl: "https://github.com/relayrunner/relayrunner/edit/main/apps/docs/",
      },
      lastUpdated: true,
    }),
  ],
});
