// Runs only for /docs/* (run_worker_first in wrangler.jsonc); everything else is served straight
// from static assets. A docs page asked for with `Accept: text/markdown` gets its Markdown version
// (/docs/<slug>.md) instead of HTML, so agents don't have to know the .md URL.

interface Env {
  ASSETS: { fetch(request: Request | URL): Promise<Response> };
}

const wantsMarkdown = (request: Request) =>
  /\btext\/markdown\b/.test(request.headers.get("Accept") ?? "");

/** /docs/concepts/routing/ → /docs/concepts/routing.md, or null for files like /docs/llms.txt. */
function markdownUrl(url: URL): URL | null {
  const path = url.pathname.replace(/\/$/, "");
  if (/\.[a-z0-9]+$/i.test(path)) return null;
  return new URL(`${path}.md`, url);
}

const withVary = (response: Response) => {
  const out = new Response(response.body, response);
  out.headers.append("Vary", "Accept");
  return out;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const md =
      request.method === "GET" && wantsMarkdown(request) && markdownUrl(new URL(request.url));
    if (md) {
      const response = await env.ASSETS.fetch(md);
      if (response.ok) return withVary(response);
    }
    return withVary(await env.ASSETS.fetch(request));
  },
};
