// Module-level caches of one workspace's data (runner reports, machines) register here, so a
// workspace switch empties them along with the router's cache (workspace-menu.tsx, router.tsx).
const clears = new Set<() => void>();

/** Runs `clear` whenever the workspace changes. */
export function clearOnWorkspaceChange(clear: () => void) {
  clears.add(clear);
}

/** Empties every registered cache. */
export function clearWorkspaceCaches() {
  for (const clear of clears) clear();
}
