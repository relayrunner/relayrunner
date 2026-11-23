// Fails when the dashboard's first load grows past BUDGET_KB: the JS and CSS that index.html loads
// and everything those files import statically, gzipped. Page code belongs in its route's lazy
// chunk; one stray value import from a route or component into the shared layout pulls it into
// every page's first load. Run after `pnpm --filter @relayrunner/web build`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const BUDGET_KB = 215;
const dist = join(import.meta.dirname, "..", "apps", "web", "dist", "client");

const html = readFileSync(join(dist, "index.html"), "utf8");
const queue = [...html.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const files = new Set();
while (queue.length) {
  const file = queue.pop();
  if (files.has(file)) continue;
  files.add(file);
  if (!file.endsWith(".js")) continue;
  const source = readFileSync(join(dist, file), "utf8");
  // Static imports only: `import "./x.js"` and `import { a } from "./x.js"`, not `import("./x.js")`.
  for (const m of source.matchAll(
    /(?:^|[;\s}])import\s*(?:[^"'()]*?from\s*)?["']\.\/([^"']+\.js)["']/g,
  ))
    queue.push(join(dirname(file), m[1]));
}

const kb =
  [...files].reduce((sum, file) => sum + gzipSync(readFileSync(join(dist, file))).length, 0) / 1024;
console.log(
  `Dashboard first load: ${kb.toFixed(1)} KB gzip in ${files.size} files (budget ${BUDGET_KB} KB).`,
);
if (kb > BUDGET_KB) {
  console.error("Over budget. Look for page code the layout or a shared module now imports.");
  process.exit(1);
}
