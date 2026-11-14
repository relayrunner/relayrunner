import type { RunnerOrder } from "@relayrunner/runner-order";
import { api } from "@/lib/api";

/** GET/PUT /api/workspaces/:id/runner-order. `isDefault` until the workspace saves one. */
export type RunnerOrderResponse = { order: RunnerOrder; isDefault: boolean };

export function getRunnerOrder(workspaceId: string) {
  return api<RunnerOrderResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/runner-order`);
}

/** A refused order fails with RUNNER_ORDER_INVALID, its message the first problem found. */
export function saveRunnerOrder(workspaceId: string, order: RunnerOrder) {
  return api<RunnerOrderResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/runner-order`, {
    method: "PUT",
    body: JSON.stringify(order),
  });
}
