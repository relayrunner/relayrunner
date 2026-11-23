// What a workspace switch keeps of the page's URL (components/workspace-menu.tsx).
// Params that mean the same in any workspace: ranges, tabs, sorting, and choices from a fixed
// list. The rest name one workspace's repos, workflows, runs, runners or people, so a workspace
// switch drops them.
const PORTABLE = new Set([
  "range",
  "days",
  "view",
  "sort",
  "by",
  "per",
  "prices",
  "p",
  "type",
  "result",
  "routed",
  "status",
  "runs",
  "inactive",
  "cloud",
  "internal",
]);

/** The params of `pathname` to keep when switching to another workspace on the same page. */
export function portableSearch(pathname: string, search: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([key]) =>
        PORTABLE.has(key) ||
        // A provider's chart is a metric; History's names a workflow.
        (key === "chart" && pathname.startsWith("/providers/")),
    ),
  );
}
