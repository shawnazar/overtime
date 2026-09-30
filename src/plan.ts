import type { GitHubClient } from "./github.js";

// Monthly included Actions minutes for GitHub-hosted runners in private repos, by plan.
// https://docs.github.com/en/billing/concepts/product-billing/github-actions
// Set `included-minutes` explicitly if your plan isn't listed or GitHub changes these.
export const INCLUDED_MINUTES: Record<string, number> = {
  free: 2000,
  pro: 3000,
  team: 3000,
  enterprise: 50000,
  business: 50000, // GitHub Enterprise Cloud reports the plan as "business" on some accounts
};

export async function includedMinutesFor(gh: GitHubClient, owner: string, ownerType: "user" | "organization"): Promise<{ minutes: number; plan: string }> {
  const path = ownerType === "organization" ? `/orgs/${owner}` : `/users/${owner}`;
  const body = await gh.request<{ plan?: { name?: string } }>("GET", path);
  const plan = body?.plan?.name?.toLowerCase();
  if (!plan) {
    throw new Error(
      `included-minutes is "auto" but the token can't see ${owner}'s plan. Grant account "Plan: Read" ` +
        `(orgs: "Administration: Read"), or set included-minutes explicitly.`,
    );
  }
  const minutes = INCLUDED_MINUTES[plan];
  if (minutes === undefined) throw new Error(`unknown plan "${plan}"; set included-minutes explicitly`);
  return { minutes, plan };
}
