// One share image per docs page, drawn at build time from its section, title and description
// (/og/docs/<slug>.png). Head.astro points og:image and twitter:image at it.
import type { APIRoute, GetStaticPaths } from "astro";
import { docsEntries, pagePath } from "../../lib/agent-docs";
import { docsCard, renderPng } from "../../lib/share-images.mjs";

// The first path segment after docs/ is the sidebar section: get-started is "Get started".
const sectionName = (id: string) => {
  const slug = id.split("/")[1] ?? "";
  const words = slug.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const getStaticPaths = (async () =>
  (await docsEntries()).map((entry) => ({
    params: { route: `${entry.id}.png` },
    props: { entry },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props, site }) => {
  const { entry } = props as Awaited<ReturnType<typeof getStaticPaths>>[number]["props"];
  const host = (site ?? new URL("https://relayrunner.app")).host;
  const png = await renderPng(
    docsCard({
      section: sectionName(entry.id),
      title: entry.data.title,
      description: entry.data.description,
      url: `${host}${pagePath(entry)}`,
    }),
  );
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
