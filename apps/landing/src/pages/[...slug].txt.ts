import type { APIRoute, GetStaticPaths } from "astro";
import { docsEntries, toText } from "../lib/agent-docs";

export const getStaticPaths = (async () => {
  const all = await docsEntries();
  return all.map((entry) => ({ params: { slug: entry.id }, props: { entry, all } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props, site }) =>
  new Response(toText(props.entry, props.all, site!), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
