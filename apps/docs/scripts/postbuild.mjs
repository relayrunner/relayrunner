// The site builds into dist/docs/ so its files live under /docs, where they will sit once the
// docs move into the landing site. This adds the files that belong at the asset root:
// - _redirects: / and /docs/ go to the first page, How it works (there is no docs home page).
// - _headers: long-lived caching for the hashed files in /docs/_astro/ (CSS, JS, fonts). Without
//   it every page load revalidates the fonts, and text paints in the fallback font first.
import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("../dist/_redirects", import.meta.url),
  "/ /docs/ 302\n/docs/ /docs/get-started/how-it-works/ 302\n",
);

writeFileSync(
  new URL("../dist/_headers", import.meta.url),
  "/docs/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n",
);
