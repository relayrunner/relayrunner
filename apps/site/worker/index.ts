// Runs only for /docs/* and / (run_worker_first in wrangler.jsonc); everything else is served
// straight from static assets.
// - A docs page asked for with `Accept: text/markdown` gets its Markdown version
//   (/docs/<slug>.md) instead of HTML, so agents don't have to know the .md URL.
// - The landing page swaps its share image for a campaign's when `?utm_content=` names one in
//   SHARE_IMAGES. Link previewers don't run JavaScript, so this has to happen here.

interface Env {
  ASSETS: { fetch(request: Request | URL): Promise<Response> };
}

interface Element {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): Element;
}
declare class HTMLRewriter {
  on(selector: string, handlers: { element(element: Element): void }): HTMLRewriter;
  transform(response: Response): Response;
}

/**
 * Share images for the landing page, by `utm_content` value. Each image is 1200×630 and lives in
 * public/og/. Any other value (or none) keeps the default public/og-image.png.
 */
const SHARE_IMAGES = new Map<string, { path: string; alt: string }>([
  [
    "minutes",
    {
      path: "/og/minutes.png",
      alt: "Out of Actions minutes? Run CI on your Mac. Fall back to GitHub or Blacksmith automatically.",
    },
  ],
]);

const wantsMarkdown = (request: Request) =>
  /\btext\/markdown\b/.test(request.headers.get("Accept") ?? "");

/** /docs/concepts/routing (or with a trailing slash) → /docs/concepts/routing.md, or null for files like /docs/llms.txt. */
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

/** Points the page's og:image and twitter:image tags (and their alt text) at a campaign's image. */
function withShareImage(response: Response, image: { path: string; alt: string }): Response {
  // Keep the origin the build wrote into the tag (the canonical site), only swap the path.
  const src = (element: Element) => {
    const current = element.getAttribute("content");
    if (current) element.setAttribute("content", new URL(image.path, current).href);
  };
  const alt = (element: Element) => {
    element.setAttribute("content", image.alt);
  };
  return new HTMLRewriter()
    .on('meta[property="og:image"]', { element: src })
    .on('meta[name="twitter:image"]', { element: src })
    .on('meta[property="og:image:alt"]', { element: alt })
    .on('meta[name="twitter:image:alt"]', { element: alt })
    .transform(response);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const response = await env.ASSETS.fetch(request);
      const image = SHARE_IMAGES.get(url.searchParams.get("utm_content") ?? "");
      const isHtml = response.headers.get("Content-Type")?.includes("text/html");
      return image && response.ok && isHtml ? withShareImage(response, image) : response;
    }

    const md = request.method === "GET" && wantsMarkdown(request) && markdownUrl(url);
    if (md) {
      const response = await env.ASSETS.fetch(md);
      if (response.ok) return withVary(response);
    }
    return withVary(await env.ASSETS.fetch(request));
  },
};
