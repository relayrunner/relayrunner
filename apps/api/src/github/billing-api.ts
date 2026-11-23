// GitHub plans, billing usage reports and budgets, for orgs, personal accounts and enterprises.

import { getJson, GitHubAccessError } from "./github-api.ts";

/** The org's GitHub plan name ("free", "team", "enterprise", ...), or null if GitHub omits it. */
export async function orgPlan(token: string, org: string): Promise<string | null> {
  const body = await getJson<{ plan?: { name?: string } }>(token, `/orgs/${org}`);
  return body.plan?.name ?? null;
}

/** One row of the org's billing usage report: a repo's usage of one SKU on one UTC day. */
export interface BillingUsageItem {
  date: string;
  product: string;
  sku: string;
  quantity: number;
  unitType: string;
  pricePerUnit?: number;
  grossAmount: number;
  discountAmount?: number;
  netAmount: number;
  // Only in an enterprise's report: the org the usage belongs to.
  organizationName?: string;
  repositoryName?: string;
}

/**
 * The org's usage report for one UTC month. Needs Organization Administration: read, which
 * installation tokens can use (verified on #116).
 */
export async function orgBillingUsage(
  token: string,
  org: string,
  month: { year: number; month: number },
): Promise<BillingUsageItem[]> {
  const body = await getJson<{ usageItems?: BillingUsageItem[] }>(
    token,
    `/organizations/${org}/settings/billing/usage?year=${month.year}&month=${month.month}`,
  );
  return body.usageItems ?? [];
}

/**
 * The signed-in user's own GitHub plan name ("free", "pro"), or null if GitHub omits it. GitHub
 * only shows `plan` to the user themself, so this takes their user-to-server token (#208).
 */
export async function userPlan(token: string): Promise<string | null> {
  const body = await getJson<{ plan?: { name?: string } }>(token, "/user");
  return body.plan?.name ?? null;
}

/**
 * A personal account's usage report for one UTC month, in the org report's shape. Needs the User
 * permission Plan: read and the account owner's own user-to-server token: installation tokens
 * can't call it, and a user can only read their own billing (#208).
 */
export async function userBillingUsage(
  token: string,
  login: string,
  month: { year: number; month: number },
): Promise<BillingUsageItem[]> {
  const body = await getJson<{ usageItems?: BillingUsageItem[] }>(
    token,
    `/users/${login}/settings/billing/usage?year=${month.year}&month=${month.month}`,
  );
  return body.usageItems ?? [];
}

/**
 * An enterprise's usage report for one UTC month, every org's rows together, each naming its org.
 * Needs an installation of the App on the enterprise with read access to enterprise billing.
 */
export async function enterpriseBillingUsage(
  token: string,
  enterprise: string,
  month: { year: number; month: number },
): Promise<BillingUsageItem[]> {
  const path = `/enterprises/${enterprise}/settings/billing/usage?year=${month.year}&month=${month.month}`;
  // GitHub's report leaves out usage that belongs to a cost center unless it's asked for by the
  // cost center's id, so each one's report is read too.
  const costCenters = await enterpriseCostCenters(token, enterprise);
  const reports = await Promise.all(
    [path, ...costCenters.map((id) => `${path}&cost_center_id=${encodeURIComponent(id)}`)].map(
      (report) => getJson<{ usageItems?: BillingUsageItem[] }>(token, report),
    ),
  );
  return reports.flatMap((report) => report.usageItems ?? []);
}

// Every cost center's id, deleted ones included: usage this month can belong to one deleted since.
// An enterprise that can't list them is read without them.
async function enterpriseCostCenters(token: string, enterprise: string): Promise<string[]> {
  try {
    const body = await getJson<{ costCenters?: { id: string }[] }>(
      token,
      `/enterprises/${enterprise}/settings/billing/cost-centers`,
    );
    return (body.costCenters ?? []).map((center) => center.id);
  } catch (error) {
    if (error instanceof GitHubAccessError) return [];
    throw error;
  }
}

/** An org or enterprise budget, trimmed to what the minutes rule needs. Amounts are whole dollars. */
export interface BillingBudget {
  scope: string;
  type: string;
  skus: string[];
  amount: number;
  preventFurtherUsage: boolean;
}

export const orgBudgets = (token: string, org: string) =>
  budgets(token, `/organizations/${org}/settings/billing/budgets`);

export const enterpriseBudgets = (token: string, enterprise: string) =>
  budgets(token, `/enterprises/${enterprise}/settings/billing/budgets`);

async function budgets(token: string, path: string): Promise<BillingBudget[]> {
  const body = await getJson<{
    budgets?: {
      budget_scope: string;
      budget_type: string;
      // The schema says budget_product_sku; GitHub's examples send budget_product_skus.
      budget_product_sku?: string;
      budget_product_skus?: string[];
      budget_amount: number;
      prevent_further_usage: boolean;
    }[];
  }>(token, path);
  return (body.budgets ?? []).map((budget) => ({
    scope: budget.budget_scope,
    type: budget.budget_type,
    skus:
      budget.budget_product_skus ?? (budget.budget_product_sku ? [budget.budget_product_sku] : []),
    amount: budget.budget_amount,
    preventFurtherUsage: budget.prevent_further_usage,
  }));
}
