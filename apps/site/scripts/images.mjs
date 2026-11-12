// Writes the images that live as files: the home page's share image (public/og-image.png) and the
// README hero in both themes (.github/readme/). Run `pnpm images` from apps/site after changing
// src/lib/share-images.mjs. The docs pages' share images are drawn at build time instead.
import { mkdirSync, writeFileSync } from "node:fs";
import { homeCard, readmeHero, renderPng } from "../src/lib/share-images.mjs";

const readme = "../../.github/readme";
mkdirSync(readme, { recursive: true });

const files = [
  ["public/og-image.png", homeCard(), 1],
  [`${readme}/hero-light.png`, readmeHero("light"), 2],
  [`${readme}/hero-dark.png`, readmeHero("dark"), 2],
];
for (const [path, element, scale] of files) {
  writeFileSync(path, await renderPng(element, scale));
  console.log(`wrote ${path}`);
}
