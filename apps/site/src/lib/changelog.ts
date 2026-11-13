import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { docsLoader } from "@astrojs/starlight/loaders";
import type { Loader } from "astro/loaders";

/*
 * /docs/changelog is built from the CLI's CHANGELOG.md, which the Release workflow writes from
 * changesets. It's added to the docs collection, so it gets the docs layout and the .md, .txt and
 * llms.txt versions like any other page, and never needs editing by hand. /changelog.xml
 * (src/pages/changelog.xml.ts) is the same notes as an RSS feed.
 */

export const CHANGELOG_ID = "docs/changelog";
export const FEED_PATH = "/changelog.xml";
const CHANGELOG = new URL("../../../cli/CHANGELOG.md", import.meta.url);

const HEADINGS: Record<string, string> = {
  "Major Changes": "Breaking changes",
  "Minor Changes": "New",
  "Patch Changes": "Fixes and improvements",
};

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

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

/** Drops the package-name title and commit ids, renames the bump-type headings, adds dates. */
function changelogBody(raw: string, dates: Map<string, Date>) {
  const intro = `Follow new releases with the [RSS feed](${FEED_PATH}).`;
  const notes = raw
    .replace(/^# .*\n+/, "")
    .replace(/^- [0-9a-f]{7,}: /gm, "- ")
    .replace(/^### (.+)$/gm, (line, name: string) =>
      HEADINGS[name] ? `### ${HEADINGS[name]}` : line,
    )
    .replace(/^## (\S+)$/gm, (line, version: string) =>
      dates.has(version) ? `${line}\n\nReleased ${DATE.format(dates.get(version))}` : line,
    )
    .trim();
  return `${intro}\n\n${notes}`;
}

/** Starlight's docs loader, plus the changelog page. */
export function docsWithChangelog(): Loader {
  const docs = docsLoader();
  return {
    name: "docs-with-changelog",
    async load(context) {
      await docs.load(context);
      const addChangelog = async () => {
        const body = changelogBody(await readFile(CHANGELOG, "utf8"), releaseDates());
        const data = await context.parseData({
          id: CHANGELOG_ID,
          data: {
            title: "Changelog",
            description: "What's new in each release of the relayrunner CLI.",
            tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 2 },
            head: [
              {
                tag: "link",
                attrs: {
                  rel: "alternate",
                  type: "application/rss+xml",
                  title: "relayrunner CLI releases",
                  href: FEED_PATH,
                },
              },
            ],
          },
        });
        context.store.set({
          id: CHANGELOG_ID,
          data,
          body,
          rendered: await context.renderMarkdown(body),
          digest: context.generateDigest(body),
        });
      };
      await addChangelog();
      const path = fileURLToPath(CHANGELOG);
      context.watcher?.add(path);
      context.watcher?.on("change", (changed) => {
        if (changed === path) void addChangelog();
      });
    },
  };
}
