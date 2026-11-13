// Runs first for /docs/* and / (run_worker_first in wrangler.jsonc), and for any path with no
// asset (not_found_handling is "none"); every other file is served straight from static assets.
// - A page asked for with `Accept: text/markdown` gets its Markdown version instead of HTML, so
//   agents don't have to know the .md URL: /docs/<slug>.md for docs pages, /index.md for /.
// - An unknown path gets a 404: the site's 404 page, or a short Markdown note for agents.
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

/**
 * Whether the request prefers Markdown: `text/markdown` is in Accept with a quality at least that
 * of `text/html`. Browsers never list it, so they keep getting HTML.
 */
export function wantsMarkdown(request: Request): boolean {
  const accept = (request.headers.get("Accept") ?? "").toLowerCase();
  if (!accept.includes("text/markdown")) return false;
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const quality = new Map<string, number>();
  for (const part of accept.split(",")) {
    const [type = "", ...params] = part.split(";").map((p) => p.trim());
    const q = params.find((p) => p.startsWith("q="));
    quality.set(type, q ? Number(q.slice(2)) || 0 : 1);
  }
  const markdown = quality.get("text/markdown") ?? 0;
  return markdown > 0 && markdown >= (quality.get("text/html") ?? 0);
}

/**
 * / → /index.md, /docs/concepts/routing (or with a trailing slash) → /docs/concepts/routing.md,
 * or null for files like /docs/llms.txt.
 */
function markdownUrl(url: URL): URL | null {
  const path = url.pathname.replace(/\/$/, "") || "/index";
  if (/\.[a-z0-9]+$/i.test(path)) return null;
  return new URL(`${path}.md`, url);
}

/** A copy of the response with Vary: Accept, and the status and Content-Type given. */
function withVary(response: Response, status = response.status, type?: string) {
  const headers = new Headers(response.headers);
  if (type) headers.set("Content-Type", type);
  headers.append("Vary", "Accept");
  return new Response(response.body, { status, headers });
}

const MARKDOWN = "text/markdown; charset=utf-8";

/** The 404 answer agents get: what happened and where to look instead. */
function notFoundMarkdown(url: URL): string {
  const abs = (path: string) => new URL(path, url).href;
  return [
    "# Page not found",
    "",
    `There's no page at \`${url.pathname}\`. It may have moved, or the link may have a typo.`,
    "",
    `- Docs: ${abs("/docs")}`,
    `- Every docs page, for agents: ${abs("/llms.txt")}`,
    `- Sitemap: ${abs("/sitemap-index.xml")}`,
    "",
  ].join("\n");
}

/** A 404 for `request`: Markdown for agents that ask for it, the site's 404 page otherwise. */
async function notFound(request: Request, url: URL, env: Env): Promise<Response> {
  if (wantsMarkdown(request)) {
    return new Response(notFoundMarkdown(url), {
      status: 404,
      headers: { "Content-Type": MARKDOWN, Vary: "Accept" },
    });
  }
  return withVary(await env.ASSETS.fetch(new URL("/404", url)), 404);
}

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

    const md = wantsMarkdown(request) && markdownUrl(url);
    if (md) {
      const response = await env.ASSETS.fetch(new Request(md, request));
      if (response.ok) return withVary(response, response.status, MARKDOWN);
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status === 404) return notFound(request, url, env);
    const image =
      url.pathname === "/" && SHARE_IMAGES.get(url.searchParams.get("utm_content") ?? "");
    const isHtml = response.headers.get("Content-Type")?.includes("text/html");
    return withVary(image && response.ok && isHtml ? withShareImage(response, image) : response);
  },
};
