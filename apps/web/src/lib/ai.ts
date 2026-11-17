import { api } from "@/lib/api";
import { authDisabled } from "@/lib/auth-client";

/**
 * When the workspace opted in to AI, or null, and what AI does for it once it does (nothing while
 * AI is off for everyone).
 */
export type AiOptIn = { since: string | null; features: { id: string; label: string }[] };

const path = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/ai`;

export function getAiOptIn(workspaceId: string): Promise<AiOptIn> {
  // The dev preview has no API behind it.
  if (authDisabled) {
    return Promise.resolve({
      since: null,
      features: [
        {
          id: "failure_cause",
          label: "Classify why a job failed, such as a flaky test or a lint error",
        },
        { id: "job_type", label: "Classify jobs by what they do, such as lint, tests or a build" },
      ],
    });
  }
  return api<AiOptIn>(path(workspaceId));
}

/** Opts the workspace in or out. Owners and admins only. */
export async function setAiOptIn(workspaceId: string, enabled: boolean) {
  if (authDisabled) return;
  await api(path(workspaceId), { method: "PUT", body: JSON.stringify({ enabled }) });
}
