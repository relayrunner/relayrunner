// @ts-check
/*
 * The docs sidebar, in reading order. astro.config.mjs passes it to Starlight, and
 * src/lib/agent-docs.ts uses the same order for llms.txt and llms-full.txt, so agents read the
 * docs in the order people do. Add a page's slug to its section when you add the file.
 */

/** @type {{ label: string; collapsed?: boolean; items: (string | { label: string; link: string })[] }[]} */
export const SIDEBAR = [
  {
    label: "Get started",
    items: [
      "docs/get-started/overview",
      "docs/get-started/github-actions",
      "docs/get-started/quickstart",
      "docs/get-started/install",
      "docs/get-started/mac-app",
      "docs/get-started/agents",
      "docs/get-started/move-over",
    ],
  },
  {
    label: "Routing",
    items: [
      "docs/concepts/principles",
      "docs/concepts/routing",
      "docs/concepts/runner-order",
      "docs/concepts/optimized-checks",
      "docs/guides/spend-controls",
    ],
  },
  {
    label: "Runners",
    items: [
      "docs/runners/providers",
      "docs/runners/self-hosted",
      "docs/runners/github",
      "docs/runners/hosted",
      "docs/reference/labels",
      "docs/contribute/add-provider",
      "docs/contribute/publish-prices",
    ],
  },
  // Collapsed groups start closed, but the one holding the current page always opens.
  {
    label: "Use cases",
    collapsed: true,
    items: [
      "docs/guides/laptop-ci",
      "docs/guides/mac-builds",
      "docs/guides/team-machines",
      "docs/guides/agent-surge",
    ],
  },
  {
    label: "Observability",
    collapsed: true,
    items: [
      "docs/dashboard/activity",
      "docs/dashboard/signals",
      "docs/dashboard/performance",
      "docs/dashboard/usage",
      "docs/dashboard/telemetry",
      "docs/dashboard/ai",
    ],
  },
  {
    label: "Developer tools",
    collapsed: true,
    items: [
      "docs/reference/cli",
      "docs/reference/relay-inputs",
      "docs/reference/repo-config",
      "docs/reference/mcp",
      "docs/reference/api",
      // An Astro page, not a docs file: Scalar renders /openapi.json there.
      { label: "API routes", link: "/docs/reference/api/routes" },
    ],
  },
  {
    label: "Admin",
    collapsed: true,
    items: [
      "docs/dashboard/workspaces",
      "docs/reference/github-app",
      "docs/reference/security",
      "docs/reference/privacy",
      "docs/dashboard/remove",
    ],
  },
  {
    label: "Help",
    collapsed: true,
    items: [
      "docs/reference/troubleshooting",
      "docs/reference/errors",
      "docs/reference/faq",
      // Built from apps/cli/CHANGELOG.md, apps/mac/CHANGELOG.md and src/content/changelog (src/lib/changelog.ts).
      "docs/changelog",
      "docs/contribute/feedback",
    ],
  },
];
