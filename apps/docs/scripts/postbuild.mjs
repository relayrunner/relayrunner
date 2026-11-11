// The site builds into dist/docs/ so its files live under /docs, where they will sit once the
// docs move into the landing site. This adds the one file that belongs at the asset root: a
// redirect from / to /docs/, so the bare workers.dev and preview URLs land on the docs.
import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("../dist/_redirects", import.meta.url),
  "/ /docs/ 302\n/docs/ /docs/get-started/how-it-works/ 302\n",
);
