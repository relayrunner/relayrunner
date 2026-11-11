import { getCollection, type CollectionEntry } from "astro:content";
import { isProviderId, providerMarkdown, providerTableMarkdown } from "./providers";

/*
 * Plain-text versions of every docs page, for agents and crawlers. Each page at /docs/<slug>/ also
 * has /docs/<slug>.md (the page as Markdown) and /docs/<slug>.txt (the same Markdown with a header
 * that tells an agent where it is and what other pages exist). /docs/llms.txt lists every page.
 */

type DocsEntry = CollectionEntry<"docs">;

export const pagePath = (entry: DocsEntry) => `/${entry.id}/`;
export const markdownPath = (entry: DocsEntry) => `/${entry.id}.md`;
export const textPath = (entry: DocsEntry) => `/${entry.id}.txt`;

export async function docsEntries() {
  return (await getCollection("docs")).filter((entry) => entry.id.startsWith("docs/"));
}

/** Starlight asides (`:::note[Title]` ... `:::`) become Markdown blockquotes. */
function asidesToBlockquotes(body: string) {
  return body.replace(
    /^:::(\w+)(?:\[(.*?)\])?\s*\n([\s\S]*?)\n:::\s*$/gm,
    (_, kind: string, title: string | undefined, text: string) => {
      const label = title || kind.charAt(0).toUpperCase() + kind.slice(1);
      const lines = text.trim().split("\n");
      return (
        [`> **${label}:** ${lines[0]}`, ...lines.slice(1).map((l) => `> ${l}`)].join("\n") + "\n"
      );
    },
  );
}

/** Drops MDX import lines, which mean nothing outside the site. */
function stripMdx(body: string) {
  return body.replace(/^import .+ from .+;?\s*$/gm, "").trim();
}

/** The docs' MDX components, written out as the Markdown they show. */
function componentsToMarkdown(body: string) {
  return body
    .replace(/^<ProviderTable\s*\/>[ \t]*$/gm, providerTableMarkdown)
    .replace(/^<Provider id="([\w-]+)"\s*\/>[ \t]*$/gm, (tag, id: string) =>
      isProviderId(id) ? providerMarkdown(id) : tag,
    );
}

export function toMarkdown(entry: DocsEntry) {
  const { title, description } = entry.data;
  const body = asidesToBlockquotes(componentsToMarkdown(stripMdx(entry.body ?? "")));
  return (
    [`# ${title}`, description ? `> ${description}` : "", body].filter(Boolean).join("\n\n") + "\n"
  );
}

export function toText(entry: DocsEntry, all: DocsEntry[], site: URL) {
  const abs = (path: string) => new URL(path, site).href;
  const index = all
    .map(
      (e) => `- ${e.data.title}: ${abs(markdownPath(e))}${e.id === entry.id ? " (this page)" : ""}`,
    )
    .join("\n");
  return [
    `RelayRunner docs: ${entry.data.title}`,
    `Page: ${abs(pagePath(entry))}`,
    `Markdown: ${abs(markdownPath(entry))}`,
    `All pages: ${abs("/docs/llms.txt")}`,
    "",
    "Other pages (Markdown):",
    index,
    "",
    "---",
    "",
    toMarkdown(entry),
  ].join("\n");
}

export function llmsIndex(all: DocsEntry[], site: URL) {
  const abs = (path: string) => new URL(path, site).href;
  const lines = all.map(
    (e) =>
      `- [${e.data.title}](${abs(markdownPath(e))})${e.data.description ? `: ${e.data.description}` : ""}`,
  );
  return [
    "# RelayRunner docs",
    "",
    "> RelayRunner routes GitHub Actions jobs to your own machines when they're online and falls back to GitHub when they're not.",
    "",
    "Each page is also available as Markdown (.md) and as plain text for agents (.txt).",
    "",
    "## Pages",
    "",
    ...lines,
    "",
  ].join("\n");
}
