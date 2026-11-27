// One share image per runner the dashboard can evaluate, drawn at build time
// (/og/evaluate/<id>.png). The dashboard's Worker points the public Evaluate page's og:image here
// (apps/web/worker/evaluate-meta.ts), since that page is a single-page app crawlers can't run.
import type { APIRoute, GetStaticPaths } from "astro";
import { evaluable, evaluateHref } from "../../../lib/evaluate";
import { INTEGRATIONS, type Integration } from "../../../lib/integrations";
import { evaluateCard, renderPng } from "../../../lib/share-images.mjs";

export const getStaticPaths = (() =>
  INTEGRATIONS.filter(({ id }) => evaluable(id)).map((integration) => ({
    params: { id: integration.id },
    props: { integration },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
  const { id, name } = (props as { integration: Integration }).integration;
  const url = evaluateHref(id).replace(/^https:\/\//, "");
  const png = await renderPng(evaluateCard({ id, name, url }));
  return new Response(png, { headers: { "Content-Type": "image/png" } });
};
