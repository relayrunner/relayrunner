// Adds the files that belong at the asset root after `astro build`:
// - _redirects: /docs and /docs/ go to the first page, Overview. There is no docs home page, so
//   without the bare /docs rule the asset server finds nothing to add a slash to and 404s. Pages
//   that moved keep their old URLs working.
// - _headers: long-lived caching for Astro's hashed files in /_astro/ (CSS, JS, fonts). Without
//   it every page load revalidates the fonts, and text paints in the fallback font first.
import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("../dist/_redirects", import.meta.url),
  [
    "/docs /docs/get-started/overview/ 302",
    "/docs/ /docs/get-started/overview/ 302",
    "/docs/ci/routing/ /docs/concepts/routing/ 301",
    "/docs/ci/free-checks/ /docs/concepts/free-checks/ 301",
    "/docs/guides/stay-under-quota/ /docs/guides/spend-controls/ 301",
    "",
  ].join("\n"),
);

writeFileSync(
  new URL("../dist/_headers", import.meta.url),
  "/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n",
);
