import type { RunnerOrder, RunnerStep } from "@relayrunner/runner-order";
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

/** A step's cap, without its quota: "When available", "While under 80%", "While under $100/mo", "No cap". */
export function ruleText(step: RunnerStep) {
  if (step.key === "machine") return "When available";
  if ("limit" in step && step.limit) return `While under ${step.limit.percent}%`;
  if ("spendLimit" in step && step.spendLimit)
    return `While under $${step.spendLimit.usd.toLocaleString("en-US")}/mo`;
  return "No cap";
}
