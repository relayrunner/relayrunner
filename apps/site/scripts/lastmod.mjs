// The sitemap's <lastmod> for each page: the date of the last commit that touched the page's
// source. Docs pages map to their .md/.mdx file; the landing page also counts the files it's built
// from. A shallow clone only knows its newest commit, which would date every page the same, so the
// history is fetched first; if that fails, pages get no <lastmod> rather than a wrong one.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const SITE_DIR = new URL("..", import.meta.url);

/** Source files per page path. Docs and other pages fall back to their own file (below). */
const SOURCES = {
  "/": [
    "src/pages/index.astro",
    "src/components/LandingRelay.astro",
    "src/components/SiteHeader.astro",
    "src/style.css",
    "src/main.ts",
    "src/landing-relay.js",
  ],
};

const git = (...args) =>
  execFileSync("git", args, { cwd: SITE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Newest commit date per file under src/, or undefined when the history isn't available. */
function commitDates() {
  try {
    if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
      git("fetch", "--unshallow", "--quiet");
    }
    const dates = new Map();
    let date;
    for (const line of git("log", "--format=@%cI", "--name-only", "--relative", "--", "src").split(
      "\n",
    )) {
      if (line.startsWith("@")) date = line.slice(1);
      else if (line && !dates.has(line)) dates.set(line, date);
    }
    return dates;
  } catch (error) {
    console.warn(
      `[sitemap] No git history, so no <lastmod> dates: ${error.message.split("\n")[0]}`,
    );
    return undefined;
  }
}

function sourcesFor(path) {
  if (SOURCES[path]) return SOURCES[path];
  const doc = `src/content/docs${path}`;
  return [`${doc}.md`, `${doc}.mdx`, `src/pages${path}.astro`].filter((file) =>
    existsSync(new URL(file, SITE_DIR)),
  );
}

/** Returns lastmod(url): the page's last change as an ISO date, or undefined if unknown. */
export function lastModified() {
  const dates = commitDates();
  return (url) => {
    if (!dates) return undefined;
    const path = new URL(url).pathname.replace(/\/$/, "") || "/";
    const found = sourcesFor(path)
      .map((file) => dates.get(file))
      .filter(Boolean)
      .sort();
    return found.at(-1);
  };
}
