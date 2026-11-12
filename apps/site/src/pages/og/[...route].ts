// One share image per docs page, rendered at build time from the page's title and description
// (/og/docs/<slug>.png). Head.astro points og:image and twitter:image at it.
import { OGImageRoute } from "astro-og-canvas";
import { docsEntries } from "../../lib/agent-docs";

const fonts = "./node_modules/@fontsource-variable";

export const { getStaticPaths, GET } = await OGImageRoute({
  param: "route",
  pages: Object.fromEntries((await docsEntries()).map((entry) => [entry.id, entry.data])),
  getImageOptions: (_path, page) => ({
    title: page.title,
    description: page.description,
    logo: { path: "./public/assets/runner-head.png", size: [96] },
    bgGradient: [[255, 255, 255]],
    border: { color: [23, 138, 46], width: 16, side: "block-start" },
    padding: 72,
    font: {
      title: { color: [14, 26, 17], size: 72, weight: "Bold", families: ["Hanken Grotesk"] },
      description: {
        color: [103, 114, 105],
        size: 36,
        lineHeight: 1.3,
        families: ["Hanken Grotesk"],
      },
    },
    fonts: [`${fonts}/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2`],
  }),
});
