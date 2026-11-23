// The dashboard's cache of API reads (TanStack Query). Pages still load through route loaders;
// panels and sections that read on their own use queries, so a reopened panel shows what it read
// last and two parts of a page asking for the same thing share one request.
import { QueryClient } from "@tanstack/react-query";
import { clearOnWorkspaceChange } from "@/lib/workspace-cache";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A failed read says so, with its own retry where the panel offers one.
      retry: false,
      // Live parts refresh on their own schedule (lib/live-refresh.ts), which already catches up
      // when the tab comes back.
      refetchOnWindowFocus: false,
    },
  },
});

// Reads are one workspace's data.
clearOnWorkspaceChange(() => queryClient.clear());
