import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest's default glob walks the whole repo, including agent worktrees under `.claude/`.
    include: ["{apps,packages,tests}/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Generous for slow CI runners: an API test that enrolls a machine makes dozens of requests.
    testTimeout: 15_000,
    setupFiles: ["tests/no-network.ts"],
  },
});
