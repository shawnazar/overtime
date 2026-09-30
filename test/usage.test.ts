import { describe, it, expect } from "vitest";
import { summarize, cycleOf, isActionsMinutes, fetchUsage } from "../src/usage.js";
import { GitHubError } from "../src/github.js";
import { client, fixture } from "./helpers.js";

const summary = fixture("billing-summary.json");
const report = fixture("billing-report.json");

describe("summarize", () => {
  it("sums summary-shaped items, ignoring storage and non-actions products", () => {
    expect(summarize(summary.usageItems, [], "2026-09", "summary")).toEqual({
      grossMinutes: 1800, includedUsed: 1700, billedMinutes: 100, billedAmount: 8, cycle: "2026-09", source: "summary",
    });
  });

  it("derives included/billed from amounts for report-shaped items, rounding to cents", () => {
    // 1000 fully discounted; 500 half billed (net 250); 100.333 fully billed.
    expect(summarize(report.usageItems, [], "2026-09", "report")).toEqual({
      grossMinutes: 1600.33, includedUsed: 1250, billedMinutes: 350.33, billedAmount: 3.6, cycle: "2026-09", source: "report",
    });
  });

  it("filters by sku substring, case-insensitively", () => {
    const u = summarize(summary.usageItems, ["MACOS"], "2026-09", "summary");
    expect(u).toMatchObject({ grossMinutes: 300, includedUsed: 200, billedMinutes: 100, billedAmount: 8 });
    const r = summarize(report.usageItems, ["linux", "nope"], "2026-09", "report");
    expect(r).toMatchObject({ grossMinutes: 1500, includedUsed: 1250, billedMinutes: 250, billedAmount: 2 });
  });

  it("treats a zero grossAmount report item as fully included", () => {
    const u = summarize([{ product: "actions", unitType: "minutes", quantity: 30, grossAmount: 0, netAmount: 0 }], [], "2026-09", "report");
    expect(u).toMatchObject({ grossMinutes: 30, includedUsed: 30, billedMinutes: 0 });
  });

  it("returns zeros for no items", () => {
    expect(summarize([], [], "2026-01", "summary")).toMatchObject({ grossMinutes: 0, includedUsed: 0, billedMinutes: 0, billedAmount: 0 });
  });
});

describe("isActionsMinutes", () => {
  it("accepts items without unitType but rejects other products and non-minute units", () => {
    expect(isActionsMinutes({ product: "Actions" }, [])).toBe(true);
    expect(isActionsMinutes({ product: "actions", unitType: "GigabyteHours" }, [])).toBe(false);
    expect(isActionsMinutes({ product: "packages", unitType: "minutes" }, [])).toBe(false);
    expect(isActionsMinutes({ unitType: "minutes" }, [])).toBe(false);
    expect(isActionsMinutes({ product: "actions", unitType: "minutes" }, ["linux"])).toBe(false);
  });
});

describe("cycleOf", () => {
  it("formats the UTC year-month with zero padding", () => {
    expect(cycleOf(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01");
    expect(cycleOf(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });
  it("uses UTC, not local time", () => {
    expect(cycleOf(new Date("2026-10-01T00:30:00+02:00"))).toBe("2026-09");
  });
});

describe("fetchUsage", () => {
  const now = new Date("2026-09-15T12:00:00Z");

  it("reads the user summary endpoint with year/month/product", async () => {
    const { gh, calls } = client((c) => (c.path === "/users/me/settings/billing/usage/summary" ? { body: summary } : undefined));
    const u = await fetchUsage(gh, "me", "user", [], now);
    expect(u).toMatchObject({ source: "summary", cycle: "2026-09", includedUsed: 1700 });
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ year: "2026", month: "9", product: "actions" });
  });

  it("uses /organizations/{org} for organizations", async () => {
    const { gh, calls } = client((c) => (c.path === "/organizations/acme/settings/billing/usage/summary" ? { body: { usageItems: [] } } : undefined));
    await fetchUsage(gh, "acme", "organization", [], now);
    expect(calls[0]!.path).toBe("/organizations/acme/settings/billing/usage/summary");
  });

  it("falls back to the detailed report when the summary 404s", async () => {
    const { gh, calls } = client((c) => (c.path === "/users/me/settings/billing/usage" ? { body: report } : undefined));
    const u = await fetchUsage(gh, "me", "user", [], now);
    expect(u.source).toBe("report");
    expect(u.includedUsed).toBe(1250);
    expect(calls.map((c) => c.path)).toEqual(["/users/me/settings/billing/usage/summary", "/users/me/settings/billing/usage"]);
  });

  it("handles an empty body", async () => {
    const { gh } = client(() => ({ status: 200, body: {} }));
    expect((await fetchUsage(gh, "me", "user", [], now)).grossMinutes).toBe(0);
  });

  it("turns 403 into a helpful permissions error without falling back", async () => {
    const { gh, calls } = client(() => ({ status: 403, body: { message: "Resource not accessible by personal access token" } }));
    const err = await fetchUsage(gh, "me", "user", [], now).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GitHubError);
    expect(err.message).toContain("Cannot read Actions billing usage (403)");
    expect(err.message).toContain('"Plan: Read"');
    expect(err.message).toContain("Resource not accessible");
    expect(calls).toHaveLength(1);
  });

  it("explains a 404 from the fallback report too", async () => {
    const { gh } = client(() => undefined);
    await expect(fetchUsage(gh, "me", "user", [], now)).rejects.toThrow("Cannot read Actions billing usage (404)");
  });

  it("passes other errors through unchanged", async () => {
    const { gh } = client(() => ({ status: 422, body: { message: "bad" } }));
    const err = await fetchUsage(gh, "me", "user", [], now).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(422);
  });
});

describe("standard-runner SKUs only by default (#8)", () => {
  const items = [
    { product: "actions", sku: "actions_linux", unitType: "minutes", grossQuantity: 100, discountQuantity: 100, netQuantity: 0, netAmount: 0 },
    { product: "actions", sku: "actions_linux_4_core", unitType: "minutes", grossQuantity: 10, discountQuantity: 0, netQuantity: 10, netAmount: 0.16 },
    { product: "actions", sku: "actions_windows_8_core", unitType: "minutes", grossQuantity: 5, discountQuantity: 0, netQuantity: 5, netAmount: 0.3 },
    { product: "actions", sku: "Actions Linux GPU", unitType: "minutes", grossQuantity: 2, discountQuantity: 0, netQuantity: 2, netAmount: 0.14 },
  ];

  it("ignores larger runners so they can't trip the overage rule on day 1", async () => {
    const { summarize } = await import("../src/usage.js");
    const u = summarize(items, [], "2026-10", "summary");
    expect(u).toMatchObject({ grossMinutes: 100, includedUsed: 100, billedMinutes: 0 });
  });

  it("the #8 repro decides hosted", async () => {
    const { summarize } = await import("../src/usage.js");
    const { decide } = await import("../src/decide.js");
    const { DEFAULTS } = await import("../src/config.js");
    const usage = summarize(items.slice(0, 2), [], "2026-10", "summary");
    const d = decide({ cfg: { ...DEFAULTS, includedMinutes: 2000 }, usage, refusals: [] });
    expect(d.mode).toBe("hosted");
  });

  it("skus: all counts every Actions minutes SKU", async () => {
    const { summarize } = await import("../src/usage.js");
    expect(summarize(items, ["all"], "2026-10", "summary").billedMinutes).toBe(17);
  });

  it("treats standard Linux arm64, Windows and macOS as standard", async () => {
    const { isStandardSku } = await import("../src/usage.js");
    for (const s of ["actions_linux", "actions_linux_arm", "Actions Linux ARM64", "actions_windows", "actions_macos"]) expect(isStandardSku(s)).toBe(true);
    for (const s of ["actions_linux_4_core", "actions_macos_12_core", "actions_linux_arm_4_core", "actions_linux_gpu", "actions_storage"]) expect(isStandardSku(s)).toBe(false);
  });
});
