import { getCollection, type CollectionEntry } from "astro:content";
import { errorTableMarkdown } from "./errors";
import { MCP_URL } from "./mcp";
import { isProviderId, providerMarkdown, providerTableMarkdown } from "./providers";
import { INTEGRATIONS, integrationPath } from "./integrations";
import { SOLUTIONS, solutionPath } from "./solutions";
import { CHANGELOG_ID } from "./changelog";
import { SIDEBAR } from "./sidebar.mjs";

/*
 * Plain-text versions of every docs page, for agents and crawlers. Each page at /docs/<slug> also
 * has /docs/<slug>.md (the page as Markdown) and /docs/<slug>.txt (the same Markdown with a header
 * that tells an agent where it is and what other pages exist). /docs/llms.txt lists every page.
 */

type DocsEntry = CollectionEntry<"docs">;

export const pagePath = (entry: DocsEntry) => `/${entry.id}`;
export const markdownPath = (entry: DocsEntry) => `/${entry.id}.md`;

const isChangelog = (entry: DocsEntry) =>
  entry.id === CHANGELOG_ID || entry.id.startsWith(`${CHANGELOG_ID}/`);

/** Sidebar position of each page, so agents read the docs in the order people do. */
const SIDEBAR_ORDER = new Map(
  SIDEBAR.flatMap((group) => group.items.filter((item) => typeof item === "string")).map(
    (id, i) => [id, i],
  ),
);

/** Every docs page in sidebar order, then pages missing from it, then the changelog pages. */
export async function docsEntries() {
  const rank = (entry: DocsEntry) =>
    isChangelog(entry) ? Infinity : (SIDEBAR_ORDER.get(entry.id) ?? SIDEBAR_ORDER.size);
  return (await getCollection("docs"))
    .filter((entry) => entry.id.startsWith("docs/"))
    .sort((a, b) => rank(a) - rank(b));
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
    .replace(/^<ErrorTable\s*\/>[ \t]*$/gm, errorTableMarkdown)
    .replace(/^<Provider id="([\w-]+)"\s*\/>[ \t]*$/gm, (tag, id: string) =>
      isProviderId(id) ? providerMarkdown(id) : tag,
    )
    .replace(
      /^<Screenshot\s+name="(\w+)"\s+alt="([^"]*)"[^>]*\/>[ \t]*$/gm,
      (_, name: string, alt: string) => `![${alt}](/screenshots/${name}-light.webp)`,
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
  const link = (e: DocsEntry) =>
    `- [${e.data.title}](${abs(markdownPath(e))})${e.data.description ? `: ${e.data.description}` : ""}`;
  const section = (label: string, entries: DocsEntry[]) =>
    entries.length ? [`## ${label}`, "", ...entries.map(link), ""] : [];
  // One section per sidebar group, in sidebar order. The changelog gets its own, last.
  const docs = all.filter((e) => !isChangelog(e));
  const inGroup = (group: (typeof SIDEBAR)[number]) => (e: DocsEntry) => group.items.includes(e.id);
  const docSections = [
    ...SIDEBAR.flatMap((group) => section(group.label, docs.filter(inGroup(group)))),
    ...section(
      "Other pages",
      docs.filter((e) => !SIDEBAR_ORDER.has(e.id)),
    ),
  ];
  return [
    "# RelayRunner",
    "",
    "> RelayRunner routes GitHub Actions jobs to the first free runner in your order: your own Mac or Linux machines, self-hosted runners, hosted runner providers, or GitHub-hosted runners. It's open source, and you change the order in the dashboard, not in your workflows.",
    "",
    // llms.txt allows only H2 sections of links, so the guidance before them has no headings.
    "**When to use RelayRunner.** Reach for it when someone wants to:",
    "",
    "- Run GitHub Actions jobs on their own laptop, Mac mini or home server, with GitHub-hosted runners as the fallback when it's offline.",
    "- Stop running out of GitHub Actions minutes, or cap how much of their included minutes CI uses.",
    "- Send jobs to a hosted runner provider, or compare providers on their own jobs, without editing workflows each time.",
    "- Get through a surge of CI jobs, such as many coding agents opening pull requests at once.",
    "- Find out where a job ran and why, how long jobs take on each runner, or what short jobs cost.",
    "",
    "It isn't a CI system or a runner host itself: workflows stay on GitHub Actions.",
    "",
    "**How an agent should use it:**",
    "",
    "- Install the agent skills with `npx skills add relayrunner/relayrunner`: one for the CLI, one for routing a repo's jobs, one for the MCP server.",
    `- To set it up in a repository, follow ${abs("/setup.md")}. The CLI (\`npx relayrunner\`) does the work, and every command has a \`--json\` flag.`,
    `- To answer questions about a workspace's runners, runs and usage, connect the MCP server at ${MCP_URL} (${abs("/docs/reference/mcp")}).`,
    `- Prefer the MCP server. Only if you're writing your own OAuth client, call the same read-only API over HTTP: ${abs("/openapi.json")} (${abs("/docs/reference/api")}).`,
    "",
    "Each docs page is also available as Markdown (.md) and as plain text for agents (.txt). Asking for a page with `Accept: text/markdown` returns its Markdown.",
    "",
    `All pages in one file: ${abs("/llms-full.txt")}`,
    "",
    "## Tools",
    "",
    `- [MCP server](${abs("/docs/reference/mcp.md")}): ${MCP_URL}, Streamable HTTP with OAuth sign-in. Discovery: ${abs("/.well-known/ai-catalog.json")}`,
    `- [API](${abs("/docs/reference/api.md")}): the read-only API behind the MCP server, for your own OAuth clients, described by ${abs("/openapi.json")}`,
    `- [CLI](${abs("/docs/reference/cli.md")}): the \`relayrunner\` npm package, https://www.npmjs.com/package/relayrunner`,
    `- [Mac app](${abs("/docs/get-started/mac-app.md")}): a menu bar app that runs \`connect\` for you, ${abs("/mac/download")}`,
    "- [Source code](https://github.com/relayrunner/relayrunner): the GitHub repository",
    "",
    ...docSections,
    "## Solutions",
    "",
    ...SOLUTIONS.map((s) => `- [${s.name}](${abs(solutionPath(s))}): ${s.blurb}`),
    "",
    "## Integrations",
    "",
    ...INTEGRATIONS.map((p) => `- [${p.name}](${abs(integrationPath(p.id))}): ${p.intro}`),
    "",
    ...section("Changelog", all.filter(isChangelog)),
  ].join("\n");
}

/** Changelog entries kept in llms-full.txt; the full list stays at /docs/changelog.md. */
const RECENT_CHANGES = 15;

/** The combined changelog cut to its newest entries, with a link to the rest. */
function recentChangelog(entry: DocsEntry, site: URL) {
  const markdown = toMarkdown(entry);
  const [head, ...sections] = markdown.split(/^(?=## )/m);
  if (sections.length <= RECENT_CHANGES) return markdown;
  const more = `Older entries: ${new URL(markdownPath(entry), site).href}\n`;
  return [head, ...sections.slice(0, RECENT_CHANGES), more].join("");
}

/**
 * Every page's Markdown in one file, for agents that want the whole docs at once: the docs in
 * sidebar order, then the newest changelog entries. The per-product changelog views and the pages
 * for single updates repeat the combined changelog, so they're left out.
 */
export function llmsFull(all: DocsEntry[], site: URL) {
  const docs = all.filter((entry) => !isChangelog(entry)).map(toMarkdown);
  const changelog = all.find((entry) => entry.id === CHANGELOG_ID);
  return [...docs, ...(changelog ? [recentChangelog(changelog, site)] : [])].join("\n---\n\n");
}
