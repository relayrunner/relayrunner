import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { docsLoader } from "@astrojs/starlight/loaders";
import type { Loader } from "astro/loaders";

/*
 * /docs/changelog merges two lists by date:
 * - CLI releases, from the CLI's CHANGELOG.md, which the Release workflow writes from changesets.
 * - Platform updates, hand-written in src/content/changelog/*.md (a title and a date in the
 *   frontmatter, a few lines of Markdown under it), only for changes worth announcing.
 * /docs/changelog/platform and /docs/changelog/cli show one list each. The pages are added to the
 * docs collection, so they get the docs layout and the .md, .txt and llms.txt versions like any
 * other page. /changelog.xml (src/pages/changelog.xml.ts) is the combined list as an RSS feed.
 */

export const CHANGELOG_ID = "docs/changelog";
export const FEED_PATH = "/changelog.xml";
const CHANGELOG = new URL("../../../cli/CHANGELOG.md", import.meta.url);
const UPDATES = new URL("../content/changelog/", import.meta.url);

const HEADINGS: Record<string, string> = {
  "Major Changes": "Breaking changes",
  "Minor Changes": "New",
  "Patch Changes": "Fixes and improvements",
};

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

type Kind = "CLI" | "Platform";
type Entry = { kind: Kind; title: string; date?: Date; body: string };

const PAGES: { id: string; kind?: Kind; label: string; title: string; description: string }[] = [
  {
    id: CHANGELOG_ID,
    label: "All",
    title: "Changelog",
    description: "What's new in RelayRunner and the CLI.",
  },
  {
    id: `${CHANGELOG_ID}/platform`,
    kind: "Platform",
    label: "Platform",
    title: "Platform changelog",
    description: "What's new in the dashboard, routing and docs.",
  },
  {
    id: `${CHANGELOG_ID}/cli`,
    kind: "CLI",
    label: "CLI",
    title: "CLI changelog",
    description: "What's new in each release of the relayrunner CLI.",
  },
];

/** Release date per version: when its "## x.y.z" line was committed. Empty without git history. */
function releaseDates() {
  const dates = new Map<string, Date>();
  try {
    const blame = execFileSync("git", ["blame", "--line-porcelain", fileURLToPath(CHANGELOG)], {
      cwd: fileURLToPath(new URL(".", CHANGELOG)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let time = 0;
    let boundary = false;
    for (const line of blame.split("\n")) {
      if (line.startsWith("committer-time ")) time = Number(line.slice(15));
      else if (line === "boundary") boundary = true;
      else if (line.startsWith("\t")) {
        const version = line.match(/^\t## (\S+)/)?.[1];
        // A shallow clone blames its oldest commit for everything before it: no date beats a wrong one.
        if (version && !boundary) dates.set(version, new Date(time * 1000));
        boundary = false;
      }
    }
  } catch {}
  return dates;
}

/** One entry per CLI release, without the package-name title and commit ids, with friendlier headings. */
function cliReleases(raw: string, dates: Map<string, Date>): Entry[] {
  const notes = raw
    .replace(/^# .*\n+/, "")
    .replace(/^- [0-9a-f]{7,}: /gm, "- ")
    .replace(/^### (.+)$/gm, (line, name: string) =>
      HEADINGS[name] ? `### ${HEADINGS[name]}` : line,
    );
  return notes.split(/^(?=## \S+$)/m).flatMap((section) => {
    const version = section.match(/^## (\S+)\n/)?.[1];
    if (!version) return [];
    const body = section.slice(section.indexOf("\n")).trim();
    return [{ kind: "CLI" as const, title: `CLI v${version}`, date: dates.get(version), body }];
  });
}

/** Hand-written platform updates: `title` and `date` (YYYY-MM-DD) frontmatter over a Markdown body. */
async function platformUpdates(): Promise<Entry[]> {
  const files = (await readdir(UPDATES).catch(() => [])).filter((file) => file.endsWith(".md"));
  return Promise.all(
    files.map(async (file) => {
      const raw = await readFile(new URL(file, UPDATES), "utf8");
      const [, frontmatter = "", body = raw] =
        raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/) ?? [];
      const field = (key: string) =>
        frontmatter
          .match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2");
      const title = field("title");
      const date = new Date(`${field("date")}T00:00:00Z`);
      if (!title || Number.isNaN(date.getTime())) {
        throw new Error(`src/content/changelog/${file} needs a title and a date (YYYY-MM-DD)`);
      }
      return { kind: "Platform" as const, title, date, body: body.trim() };
    }),
  );
}

/** Newest first. A CLI release with no known date (a shallow clone) keeps its place after the newer one. */
function byDate(entries: Entry[]) {
  let last = Infinity;
  const time = new Map(
    entries.map((entry) => {
      if (entry.date) last = entry.date.getTime();
      return [entry, entry.date?.getTime() ?? last];
    }),
  );
  return entries.sort((a, b) => time.get(b)! - time.get(a)!);
}

function pageBody(page: (typeof PAGES)[number], entries: Entry[]) {
  const filter = PAGES.map((other) =>
    other === page ? `**${other.label}**` : `[${other.label}](/${other.id})`,
  ).join(" · ");
  const intro = `Show: ${filter}\n\nFollow along with the [RSS feed](${FEED_PATH}).`;
  const sections = entries
    .filter((entry) => !page.kind || entry.kind === page.kind)
    .map((entry) => {
      const label = entry.kind === "CLI" ? "CLI release" : "Platform update";
      const meta = entry.date ? `${label} · ${DATE.format(entry.date)}` : label;
      return `## ${entry.title}\n\n${meta}\n\n${entry.body}`;
    });
  return [intro, ...sections].join("\n\n");
}

/** Starlight's docs loader, plus the changelog pages. */
export function docsWithChangelog(): Loader {
  const docs = docsLoader();
  return {
    name: "docs-with-changelog",
    async load(context) {
      await docs.load(context);
      const addChangelog = async () => {
        const entries = byDate([
          ...cliReleases(await readFile(CHANGELOG, "utf8"), releaseDates()),
          ...(await platformUpdates()),
        ]);
        for (const page of PAGES) {
          const body = pageBody(page, entries);
          const data = await context.parseData({
            id: page.id,
            data: {
              title: page.title,
              description: page.description,
              tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 2 },
              head: [
                {
                  tag: "link",
                  attrs: {
                    rel: "alternate",
                    type: "application/rss+xml",
                    title: "RelayRunner changelog",
                    href: FEED_PATH,
                  },
                },
              ],
            },
          });
          context.store.set({
            id: page.id,
            data,
            body,
            rendered: await context.renderMarkdown(body),
            digest: context.generateDigest(body),
          });
        }
      };
      await addChangelog();
      const watched = [fileURLToPath(CHANGELOG), fileURLToPath(UPDATES)];
      context.watcher?.add(watched);
      context.watcher?.on("all", (_, changed) => {
        if (watched.some((path) => changed.startsWith(path))) void addChangelog();
      });
    },
  };
}
