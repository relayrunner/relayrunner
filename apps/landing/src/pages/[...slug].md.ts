import type { APIRoute, GetStaticPaths } from "astro";
import { docsEntries, toMarkdown } from "../lib/agent-docs";

export const getStaticPaths = (async () =>
  (await docsEntries()).map((entry) => ({
    params: { slug: entry.id },
    props: { entry },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(toMarkdown(props.entry), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
