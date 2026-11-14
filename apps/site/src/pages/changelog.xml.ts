// /changelog.xml: the changelog page (src/lib/changelog.ts) as an RSS feed, one item per release.
// Its media type is set in _headers (scripts/postbuild.mjs), since a static build drops headers.
import type { APIRoute } from "astro";
import { getEntry } from "astro:content";
import { CHANGELOG_ID, FEED_PATH } from "../lib/changelog";

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const GET: APIRoute = async ({ site }) => {
  const entry = await getEntry("docs", CHANGELOG_ID);
  const page = new URL(`/${CHANGELOG_ID}`, site).href;
  // The rendered page has one <h2 id="..."> per version, then its "Released <date>" line when the
  // date is known; each version becomes an item.
  const items = (entry?.rendered?.html ?? "").split(/(?=<h2\b)/).flatMap((section) => {
    const heading = section.match(/^<h2 id="([^"]+)">([^<]+)<\/h2>/);
    if (!heading) return [];
    const [tag, id, title] = heading;
    const released = section.match(/<p>Released ([^<]+)<\/p>/);
    const date = released && new Date(`${released[1]} UTC`);
    const notes = section
      .slice(tag.length)
      .replace(released?.[0] ?? "", "")
      .trim();
    return [
      [
        "    <item>",
        `      <title>${title}</title>`,
        `      <link>${page}#${id}</link>`,
        `      <guid isPermaLink="false">${id}</guid>`,
        date ? `      <pubDate>${date.toUTCString()}</pubDate>` : "",
        `      <description>${escape(notes)}</description>`,
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n"),
    ];
  });
  return new Response(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
      "  <channel>",
      "    <title>RelayRunner changelog</title>",
      `    <link>${page}</link>`,
      `    <atom:link href="${new URL(FEED_PATH, site).href}" rel="self" type="application/rss+xml"/>`,
      "    <description>What's new in each RelayRunner release.</description>",
      "    <language>en</language>",
      ...items,
      "  </channel>",
      "</rss>",
      "",
    ].join("\n"),
  );
};
