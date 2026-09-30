import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { run, summaryMarkdown } from "../src/run.js";
import type { State } from "../src/decide.js";
import type { Config } from "../src/config.js";
import { client, config, type Call } from "./helpers.js";

const NOW = new Date("2026-09-15T12:00:00Z");
const BILLING_MSG = "The job was not started because recent account payments have failed or your spending limit needs to be increased.";

interface World {
  ownerType: "User" | "Organization";
  includedUsed: number;
  billed: number;
  /** "repo/NAME" -> value */
  vars: Map<string, string>;
  /** repo -> failed runs with their jobs + annotations */
  runs: Record<string, { id: number; jobs: { id: number; name: string; ran?: boolean; message: string }[] }[]>;
}

/** A small in-memory GitHub API: owner "me", variables, billing summary, runs/jobs/annotations, reruns. */
function fakeGitHub(world: World) {
  const route = (c: Call) => {
    const p = c.path;
    let m: RegExpMatchArray | null;
    if (c.method === "GET" && p === "/users/me") return { body: { login: "me", type: world.ownerType } };
    if (c.method === "GET" && p === "/users/me/settings/billing/usage/summary") {
      return {
        body: {
          usageItems: [{
            product: "Actions", sku: "Actions Linux", unitType: "Minutes",
            grossQuantity: world.includedUsed + world.billed, discountQuantity: world.includedUsed,
            netQuantity: world.billed, netAmount: world.billed * 0.008,
          }],
        },
      };
    }
    if ((m = p.match(/^\/repos\/me\/([^/]+)\/actions\/variables\/(\w+)$/))) {
      const key = `${m[1]}/${m[2]}`;
      if (c.method === "GET") return world.vars.has(key) ? { body: { name: m[2], value: world.vars.get(key) } } : undefined;
      if (c.method === "PATCH") {
        if (!world.vars.has(key)) return undefined;
        world.vars.set(key, (c.body as { value: string }).value);
        return { status: 204 };
      }
    }
    if (c.method === "POST" && (m = p.match(/^\/repos\/me\/([^/]+)\/actions\/variables$/))) {
      const { name, value } = c.body as { name: string; value: string };
      const key = `${m[1]}/${name}`;
      if (world.vars.has(key)) return { status: 409, body: { message: "Already exists" } };
      world.vars.set(key, value);
      return { status: 201 };
    }
    if (c.method === "GET" && (m = p.match(/^\/repos\/me\/([^/]+)\/actions\/runs$/))) {
      return { body: { workflow_runs: (world.runs[m[1]!] ?? []).map((r) => ({ id: r.id })) } };
    }
    if (c.method === "GET" && (m = p.match(/^\/repos\/me\/([^/]+)\/actions\/runs\/(\d+)\/jobs$/))) {
      const r = (world.runs[m[1]!] ?? []).find((x) => x.id === Number(m![2]));
      return {
        body: {
          jobs: (r?.jobs ?? []).map((j) => ({
            id: j.id, name: j.name, conclusion: "failure", runner_name: j.ran ? "GitHub Actions 2" : null, steps: j.ran ? [{ name: "Set up job" }] : [],
          })),
        },
      };
    }
    if (c.method === "GET" && (m = p.match(/^\/repos\/me\/([^/]+)\/check-runs\/(\d+)\/annotations$/))) {
      const job = (world.runs[m[1]!] ?? []).flatMap((r) => r.jobs).find((j) => j.id === Number(m![2]));
      return { body: job ? [{ message: job.message }] : [] };
    }
    if (c.method === "POST" && /^\/repos\/me\/[^/]+\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(p)) return { status: 201, body: {} };
    return undefined;
  };
  return client(route, 0);
}

const world = (over: Partial<World> = {}): World => ({ ownerType: "User", includedUsed: 100, billed: 0, vars: new Map(), runs: {}, ...over });
const state = (mode: State["mode"], cycle = "2026-09"): string => JSON.stringify({ mode, cycle, since: "2026-09-01T00:00:00.000Z", reason: "earlier" });
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

let webhook: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  // notify() uses the global fetch; stub it so no request can leave the machine.
  webhook = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", webhook);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const withNotify = (over: Partial<Config> = {}) => config({ notify: [{ format: "generic", url: "https://hooks.example/overtime" }], ...over });

describe("run (end to end against a fake GitHub)", () => {
  it("first run under the threshold: hosted, variables created, state saved, notifies", async () => {
    const w = world({ includedUsed: 100 });
    const { gh, calls } = fakeGitHub(w);
    const r = await run(withNotify(), NOW, gh);

    expect(r.decision).toMatchObject({ mode: "hosted", changed: true, percentUsed: 5 });
    expect(r.usage).toMatchObject({ cycle: "2026-09", includedUsed: 100, source: "summary" });
    expect(r.repos.map((x) => [x.repo, x.action, x.value])).toEqual([["a", "created", '"ubuntu-latest"'], ["b", "created", '"ubuntu-latest"']]);
    expect(w.vars.get("a/CI_RUNS_ON")).toBe('"ubuntu-latest"');
    expect(w.vars.get("b/CI_RUNS_ON")).toBe('"ubuntu-latest"');

    const saved = JSON.parse(w.vars.get("a/OVERTIME_STATE")!) as State;
    expect(saved).toEqual({ mode: "hosted", cycle: "2026-09", since: NOW.toISOString(), reason: r.decision.reason });
    expect(r.reruns).toEqual([]);
    expect(r.warnings).toEqual([]);

    expect(webhook).toHaveBeenCalledTimes(1);
    const [url, init] = webhook.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://hooks.example/overtime");
    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({ event: "overtime.mode_changed", mode: "hosted", repos: ["a", "b"] });
    expect(payload).not.toHaveProperty("previous");
    // Only GitHub writes: two variables and the state.
    expect(writes(calls).map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/me/a/actions/variables", "POST /repos/me/b/actions/variables", "POST /repos/me/a/actions/variables",
    ]);
  });

  it("billing refusals flip to self-hosted, update variables and state, and re-run refused runs only", async () => {
    const w = world({
      includedUsed: 400,
      vars: new Map([["a/CI_RUNS_ON", '"ubuntu-latest"'], ["b/CI_RUNS_ON", '"ubuntu-latest"'], ["a/OVERTIME_STATE", state("hosted")]]),
      runs: {
        a: [
          { id: 11, jobs: [{ id: 1, name: "build", message: BILLING_MSG }, { id: 2, name: "lint", message: BILLING_MSG }] },
          { id: 12, jobs: [{ id: 3, name: "test", ran: true, message: BILLING_MSG }] }, // actually ran: not a refusal
        ],
        b: [{ id: 21, jobs: [{ id: 4, name: "gpu", message: "No runner matching the specified labels was found: gpu" }] }],
      },
    });
    const { gh, calls } = fakeGitHub(w);
    const r = await run(withNotify(), NOW, gh);

    expect(r.refusals.map((x) => `${x.repo}#${x.runId}:${x.jobName}`)).toEqual(["a#11:build", "a#11:lint"]);
    expect(r.decision).toMatchObject({ mode: "self-hosted", changed: true });
    expect(r.decision.reason).toMatch(/^GitHub refused 2 hosted job\(s\), e\.g\. a run 11/);
    expect(r.repos.map((x) => x.action)).toEqual(["updated", "updated"]);
    expect(w.vars.get("a/CI_RUNS_ON")).toBe('["self-hosted"]');
    expect(w.vars.get("b/CI_RUNS_ON")).toBe('["self-hosted"]');
    expect(JSON.parse(w.vars.get("a/OVERTIME_STATE")!)).toMatchObject({ mode: "self-hosted", cycle: "2026-09", since: NOW.toISOString() });

    // One rerun per run, deduplicated across its two refused jobs.
    expect(r.reruns).toEqual([11]);
    expect(calls.filter((c) => c.path.endsWith("/rerun-failed-jobs")).map((c) => c.path)).toEqual(["/repos/me/a/actions/runs/11/rerun-failed-jobs"]);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(JSON.parse((webhook.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ mode: "self-hosted", previous: "hosted" });
  });

  it("does not re-run refused jobs when rerun-refused is off", async () => {
    const w = world({ runs: { a: [{ id: 11, jobs: [{ id: 1, name: "build", message: BILLING_MSG }] }] } });
    const { gh, calls } = fakeGitHub(w);
    const r = await run(config({ rerunRefused: false }), NOW, gh);
    expect(r.decision.mode).toBe("self-hosted");
    expect(r.reruns).toEqual([]);
    expect(calls.some((c) => c.path.endsWith("/rerun-failed-jobs"))).toBe(false);
  });

  it("skips refusal detection when disabled", async () => {
    const w = world({ runs: { a: [{ id: 11, jobs: [{ id: 1, name: "build", message: BILLING_MSG }] }] } });
    const { gh, calls } = fakeGitHub(w);
    const r = await run(config({ detectRefusals: false }), NOW, gh);
    expect(r.decision.mode).toBe("hosted");
    expect(calls.some((c) => c.path.includes("/actions/runs"))).toBe(false);
  });

  it("over the percent threshold with no change: nothing written, no notification", async () => {
    const w = world({
      includedUsed: 1900,
      vars: new Map([["a/CI_RUNS_ON", '["self-hosted"]'], ["b/CI_RUNS_ON", '["self-hosted"]'], ["a/OVERTIME_STATE", state("self-hosted")]]),
    });
    const { gh, calls } = fakeGitHub(w);
    const r = await run(withNotify(), NOW, gh);
    expect(r.decision).toMatchObject({ mode: "self-hosted", changed: false, percentUsed: 95 });
    expect(r.repos.map((x) => x.action)).toEqual(["unchanged", "unchanged"]);
    expect(writes(calls)).toEqual([]);
    expect(webhook).not.toHaveBeenCalled();
  });

  it("stays self-hosted for the rest of the cycle, then returns to hosted on a new cycle", async () => {
    const vars = new Map([["a/CI_RUNS_ON", '["self-hosted"]'], ["b/CI_RUNS_ON", '["self-hosted"]'], ["a/OVERTIME_STATE", state("self-hosted", "2026-09")]]);
    const same = fakeGitHub(world({ includedUsed: 10, vars }));
    expect((await run(config(), NOW, same.gh)).decision).toMatchObject({ mode: "self-hosted", changed: false });
    expect(writes(same.calls)).toEqual([]);

    const next = fakeGitHub(world({ includedUsed: 10, vars }));
    const r = await run(withNotify(), new Date("2026-10-01T00:05:00Z"), next.gh);
    expect(r.decision).toMatchObject({ mode: "hosted", changed: true });
    expect(r.decision.reason).toMatch(/new billing cycle 2026-10/);
    expect(vars.get("a/CI_RUNS_ON")).toBe('"ubuntu-latest"');
    expect(JSON.parse(vars.get("a/OVERTIME_STATE")!)).toMatchObject({ mode: "hosted", cycle: "2026-10" });
    expect(webhook).toHaveBeenCalledTimes(1);
  });

  it("saves state on a new cycle even when the mode is unchanged, keeping 'since'", async () => {
    const vars = new Map([["a/CI_RUNS_ON", '"ubuntu-latest"'], ["b/CI_RUNS_ON", '"ubuntu-latest"'], ["a/OVERTIME_STATE", state("hosted", "2026-08")]]);
    const { gh } = fakeGitHub(world({ vars }));
    const r = await run(withNotify(), NOW, gh);
    expect(r.decision.changed).toBe(false);
    expect(JSON.parse(vars.get("a/OVERTIME_STATE")!)).toMatchObject({ mode: "hosted", cycle: "2026-09", since: "2026-09-01T00:00:00.000Z" });
    expect(webhook).not.toHaveBeenCalled();
  });

  it("honours the force variable in the state repo", async () => {
    const w = world({ includedUsed: 0, vars: new Map([["a/OVERTIME_FORCE", "self-hosted"]]) });
    const { gh } = fakeGitHub(w);
    const r = await run(config(), NOW, gh);
    expect(r.decision).toMatchObject({ mode: "self-hosted", reason: "forced by variable (self-hosted)" });
    expect(w.vars.get("b/CI_RUNS_ON")).toBe('["self-hosted"]');
  });

  it("dry run decides and reports but writes nothing to GitHub", async () => {
    const w = world({
      includedUsed: 1900,
      vars: new Map([["a/CI_RUNS_ON", '"ubuntu-latest"']]),
      runs: { a: [{ id: 11, jobs: [{ id: 1, name: "build", message: BILLING_MSG }] }] },
    });
    const before = new Map(w.vars);
    const { gh, calls } = fakeGitHub(w);
    const r = await run(withNotify({ dryRun: true }), NOW, gh);
    expect(r.decision.mode).toBe("self-hosted");
    expect(r.repos.map((x) => x.action)).toEqual(["would-update", "would-create"]);
    expect(r.reruns).toEqual([]);
    expect(writes(calls)).toEqual([]);
    expect(w.vars).toEqual(before);
    // The notification still goes out, flagged as a dry run.
    expect(JSON.parse((webhook.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ dryRun: true });
  });

  it("uses organization billing when the owner is an organization", async () => {
    const { gh, calls } = client((c) => {
      if (c.path === "/users/me") return { body: { type: "Organization" } };
      if (c.path === "/organizations/me/settings/billing/usage/summary") return { body: { usageItems: [] } };
      if (c.method !== "GET") return { status: 201 };
      return undefined;
    }, 0);
    const r = await run(config({ detectRefusals: false }), NOW, gh);
    expect(r.usage.source).toBe("summary");
    expect(calls.some((c) => c.path === "/organizations/me/settings/billing/usage/summary")).toBe(true);
  });

  it("collects warnings for failed repos and webhook errors instead of throwing", async () => {
    webhook.mockImplementation(async () => new Response("no", { status: 500 }));
    const { gh } = client((c) => {
      if (c.path === "/users/me") return { body: { type: "User" } };
      if (c.path.endsWith("/usage/summary")) return { body: { usageItems: [] } };
      if (c.path.startsWith("/repos/me/b/")) return { status: 403, body: "forbidden" };
      if (c.method !== "GET") return { status: 201 };
      return undefined;
    }, 0);
    const r = await run(withNotify({ detectRefusals: false }), NOW, gh);
    expect(r.repos.find((x) => x.repo === "b")!.action).toBe("failed");
    expect(r.warnings).toEqual([expect.stringMatching(/^b: GitHub API GET .* -> 403/), "generic webhook -> 500"]);
  });
});

describe("summaryMarkdown", () => {
  it("shows the mode, reason, usage and repo tables", async () => {
    const w = world({ includedUsed: 1900, billed: 25, runs: { a: [{ id: 11, jobs: [{ id: 1, name: "build", message: BILLING_MSG }] }] } });
    const { gh } = fakeGitHub(w);
    const cfg = config();
    const r = await run(cfg, NOW, gh);
    const md = summaryMarkdown(r, cfg);
    expect(md).toContain("## ⏱️ Overtime: 🏠 self-hosted");
    expect(md).not.toContain("(dry run)");
    expect(md).toContain(`**Why:** ${r.decision.reason}`);
    expect(md).toContain("| 2026-09 | 1925 min | 1900 min (95%) | 2000 min | 25 min / $0.2 |");
    expect(md).toContain("| Repository | Variable | Value | Result |");
    expect(md).toContain('| a | `CI_RUNS_ON` | `["self-hosted"]` | created |');
    expect(md).toContain('| b | `CI_RUNS_ON` | `["self-hosted"]` | created |');
    expect(md).toContain("**Refused jobs:** a#11 (re-ran 1)");
  });

  it("marks dry runs, empty repo lists and warnings", () => {
    const cfg = config({ dryRun: true });
    const md = summaryMarkdown({
      decision: { mode: "hosted", reason: "5% used", percentUsed: 5, changed: false },
      usage: { grossMinutes: 100, includedUsed: 100, billedMinutes: 0, billedAmount: 0, cycle: "2026-09", source: "summary" },
      refusals: [], repos: [], reruns: [], warnings: ["no repositories matched the selection"],
    }, cfg);
    expect(md).toContain("## ⏱️ Overtime: ☁️ GitHub-hosted (dry run)");
    expect(md).toContain("| (none) | | | |");
    expect(md).toContain("**Warnings:**\n- no repositories matched the selection");
    expect(md).not.toContain("Refused jobs");
  });
});
