import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// A page per HTML entry. Workers static assets serves privacy.html at /privacy and terms.html at
// /terms (html_handling defaults to auto-trailing-slash).
const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: page("./index.html"),
        privacy: page("./privacy.html"),
        terms: page("./terms.html"),
      },
    },
  },
});
