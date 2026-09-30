import type { GitHubClient } from "./github.js";
import { GitHubError } from "./github.js";

export interface Usage {
  /** Minutes GitHub counted this cycle (after OS multipliers, as GitHub reports them). */
  grossMinutes: number;
  /** Minutes covered by the plan's included allowance. */
  includedUsed: number;
  /** Minutes billed beyond the allowance. */
  billedMinutes: number;
  billedAmount: number;
  cycle: string; // YYYY-MM
  source: "summary" | "report";
}

interface UsageItem {
  product?: string;
  sku?: string;
  unitType?: string;
  grossQuantity?: number;
  discountQuantity?: number;
  netQuantity?: number;
  netAmount?: number;
  quantity?: number;
  discountAmount?: number;
  grossAmount?: number;
}

export function cycleOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Keep only Actions minute SKUs (optionally narrowed by `skus` substrings). */
export function isActionsMinutes(item: UsageItem, skus: string[]): boolean {
  if (!/^actions$/i.test(item.product ?? "")) return false;
  if (item.unitType && !/minute/i.test(item.unitType)) return false; // storage etc.
  if (!skus.length) return true;
  const sku = (item.sku ?? "").toLowerCase();
  return skus.some((s) => sku.includes(s.toLowerCase()));
}

export function summarize(items: UsageItem[], skus: string[], cycle: string, source: Usage["source"]): Usage {
  const u: Usage = { grossMinutes: 0, includedUsed: 0, billedMinutes: 0, billedAmount: 0, cycle, source };
  for (const it of items.filter((i) => isActionsMinutes(i, skus))) {
    const gross = it.grossQuantity ?? it.quantity ?? 0;
    const net = it.netQuantity ?? (it.grossAmount && it.netAmount !== undefined && it.grossAmount > 0 ? gross * (it.netAmount / it.grossAmount) : 0);
    u.grossMinutes += gross;
    u.includedUsed += it.discountQuantity ?? Math.max(0, gross - net);
    u.billedMinutes += net;
    u.billedAmount += it.netAmount ?? 0;
  }
  for (const k of ["grossMinutes", "includedUsed", "billedMinutes", "billedAmount"] as const) u[k] = Math.round(u[k] * 100) / 100;
  return u;
}

export async function fetchUsage(gh: GitHubClient, owner: string, ownerType: "user" | "organization", skus: string[], now: Date): Promise<Usage> {
  const base = ownerType === "organization" ? `/organizations/${owner}` : `/users/${owner}`;
  const query = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, product: "actions" };
  const cycle = cycleOf(now);
  try {
    const body = await gh.request<{ usageItems?: UsageItem[] }>("GET", `${base}/settings/billing/usage/summary`, { query });
    return summarize(body?.usageItems ?? [], skus, cycle, "summary");
  } catch (e) {
    // Older accounts/APIs only expose the detailed report.
    if (!(e instanceof GitHubError) || e.status !== 404) throw explain(e);
    const body = await gh.request<{ usageItems?: UsageItem[] }>("GET", `${base}/settings/billing/usage`, { query }).catch((err) => { throw explain(err); });
    return summarize(body?.usageItems ?? [], skus, cycle, "report");
  }
}

function explain(e: unknown): unknown {
  if (e instanceof GitHubError && (e.status === 401 || e.status === 403 || e.status === 404)) {
    return new Error(
      `Cannot read Actions billing usage (${e.status}). The token needs billing read access: ` +
        `fine-grained PAT with account permission "Plan: Read" (users) or org "Administration: Read"; ` +
        `or a classic PAT with "user" / "read:org" scope. ${e.message}`,
    );
  }
  return e;
}
