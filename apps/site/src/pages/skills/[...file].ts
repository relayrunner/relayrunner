import type { APIRoute, GetStaticPaths } from "astro";
import { skillFiles, skillText } from "../../lib/agent-setup";

// The agent skills from skills/, at /skills/<name>/SKILL.md (and their references), so the setup
// guide's links stay on the site.
export const getStaticPaths = (() =>
  skillFiles().map(({ file, text }) => ({
    params: { file },
    props: { text },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props, site }) =>
  new Response(skillText(props.text as string, site!), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
