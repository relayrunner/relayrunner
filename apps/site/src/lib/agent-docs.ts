import { getCollection, type CollectionEntry } from "astro:content";
import { MCP_URL } from "./mcp";
import { isProviderId, providerMarkdown, providerTableMarkdown } from "./providers";
import { INTEGRATIONS, integrationPath } from "./integrations";
import { SOLUTIONS, solutionPath } from "./solutions";

/*
 * Plain-text versions of every docs page, for agents and crawlers. Each page at /docs/<slug> also
 * has /docs/<slug>.md (the page as Markdown) and /docs/<slug>.txt (the same Markdown with a header
 * that tells an agent where it is and what other pages exist). /docs/llms.txt lists every page.
 */

type DocsEntry = CollectionEntry<"docs">;

export const pagePath = (entry: DocsEntry) => `/${entry.id}`;
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
    `- To set it up in a repository, follow ${abs("/docs/get-started/agents")}. The CLI (\`npx relayrunner\`) does the work, and every command has a \`--json\` flag.`,
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
    "- [Source code](https://github.com/relayrunner/relayrunner): the GitHub repository",
    "",
    "## Solutions",
    "",
    ...SOLUTIONS.map((s) => `- [${s.name}](${abs(solutionPath(s))}): ${s.blurb}`),
    "",
    "## Integrations",
    "",
    ...INTEGRATIONS.map((p) => `- [${p.name}](${abs(integrationPath(p.id))}): ${p.intro}`),
    "",
    "## Pages",
    "",
    ...lines,
    "",
  ].join("\n");
}

/** Every page's Markdown in one file, for agents that want the whole docs at once. */
export const llmsFull = (all: DocsEntry[]) => all.map(toMarkdown).join("\n---\n\n");
