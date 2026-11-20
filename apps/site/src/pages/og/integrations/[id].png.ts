// One share image per integration page, drawn at build time (/og/integrations/<id>.png): your
// machines first, and this provider when they're busy. The page's PageMeta points og:image at it.
import type { APIRoute, GetStaticPaths } from "astro";
import { INTEGRATIONS, integrationPath, type Integration } from "../../../lib/integrations";
import { integrationCard, renderPng } from "../../../lib/share-images.mjs";

export const getStaticPaths = (() =>
  INTEGRATIONS.map((integration) => ({
    params: { id: integration.id },
    props: { integration },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props, site }) => {
  const { id, name } = (props as { integration: Integration }).integration;
  const host = (site ?? new URL("https://relayrunner.dev")).host;
  const png = await renderPng(integrationCard({ id, name, url: `${host}${integrationPath(id)}` }));
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
