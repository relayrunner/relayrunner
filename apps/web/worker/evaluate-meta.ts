/**
 * Share tags for the public Evaluate page (/evaluate/<provider>, src/routes/evaluate.$provider.tsx).
 * The dashboard is a single-page app, and link previews (Slack, X, LinkedIn) read the HTML without
 * running it, so the Worker writes this provider's title, description and share image into
 * index.html before serving it. The image is drawn by the site at build time
 * (apps/site/src/pages/og/evaluate/[id].png.ts).
 */
import { AUTO_SIZES, isProviderId, labelForSize, PROVIDERS } from "@relayrunner/providers";

const SITE = "https://relayrunner.dev";
const PATH = /^\/evaluate\/([a-z0-9-]+)\/?$/;

/** The provider a public Evaluate path names, when the dashboard can evaluate it. */
function evaluateProvider(pathname: string) {
  const id = PATH.exec(pathname)?.[1];
  if (!id || id === "github" || !isProviderId(id)) return null;
  // The same test as the page and the site's Evaluate buttons: a Linux label for an auto size.
  if (!AUTO_SIZES.some((vcpus) => labelForSize(id, vcpus, 0))) return null;
  return { id, name: PROVIDERS[id].name };
}

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** index.html with this provider's share tags, or null when the path isn't one to tag. */
export async function evaluatePage(request: Request, assets: Fetcher) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const provider = evaluateProvider(url.pathname);
  if (!provider) return null;
  const page = await assets.fetch(new Request(new URL("/", url), request));
  if (!page.ok || !page.headers.get("content-type")?.includes("text/html")) return page;

  const title = `Evaluate ${provider.name} · RelayRunner`;
  const description = `See how your own workflows run on ${provider.name}, in time and cost, next to the runners you use today. Nothing in your repo changes.`;
  const image = `${SITE}/og/evaluate/${provider.id}.png`;
  const tags = [
    ["name", "description", description],
    ["property", "og:type", "website"],
    ["property", "og:site_name", "RelayRunner"],
    ["property", "og:title", `Benchmark your CI on ${provider.name}`],
    ["property", "og:description", description],
    ["property", "og:url", `${url.origin}/evaluate/${provider.id}`],
    ["property", "og:image", image],
    ["property", "og:image:width", "1200"],
    ["property", "og:image:height", "630"],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", `Benchmark your CI on ${provider.name}`],
    ["name", "twitter:description", description],
    ["name", "twitter:image", image],
  ]
    .map(([key, name, content]) => `<meta ${key}="${name}" content="${escape(content)}" />`)
    .join("\n    ");

  return new HTMLRewriter()
    .on("title", {
      element(element) {
        element.setInnerContent(title);
      },
    })
    .on("head", {
      element(element) {
        element.append(`    ${tags}\n  `, { html: true });
      },
    })
    .transform(page);
}
