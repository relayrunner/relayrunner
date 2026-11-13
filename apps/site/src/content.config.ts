import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";
import { docsWithChangelog } from "./lib/changelog";

export const collections = {
  docs: defineCollection({ loader: docsWithChangelog(), schema: docsSchema() }),
};
