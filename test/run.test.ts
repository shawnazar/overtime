import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { run, summaryMarkdown, watchdog, watchdogSummaryMarkdown, tokenExpiryWarning } from "../src/run.js";
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
  runs: Record<string, { id: number; jobs: { id: number; name: string; ran?: boolean; message: string; labels?: string[] }[] }[]>;
  /** Fine-grained PAT: annotations answer 403, so refusal detection falls back to the heuristic. */
  annotations403?: boolean;
  /** Value of the github-authentication-token-expiration header on every response. */
  tokenExpires?: string;
}

/** A small in-memory GitHub API: owner "me", variables, billing summary, runs/jobs/annotations, reruns. */
function fakeGitHub(world: World) {
  const route = (c: Call) => {
    const r = inner(c);
    return r && world.tokenExpires ? { ...r, headers: { ...r.headers, "github-authentication-token-expiration": world.tokenExpires } } : r;
  };
  const inner = (c: Call): { status?: number; body?: unknown; headers?: Record<string, string> } | undefined => {
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
            id: j.id, name: j.name, labels: j.labels ?? [], conclusion: "failure", runner_name: j.ran ? "GitHub Actions 2" : null, steps: j.ran ? [{ name: "Set up job" }] : [],
          })),
        },
      };
    }
    if (c.method === "GET" && (m = p.match(/^\/repos\/me\/([^/]+)\/check-runs\/(\d+)\/annotations$/))) {
      if (world.annotations403) return { status: 403, body: { message: "Resource not accessible by personal access token" } };
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
    expect(saved).toEqual({ mode: "hosted", cycle: "2026-09", since: NOW.toISOString(), reason: r.decision.reason, lastChecked: NOW.toISOString() });
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

  it("over the percent threshold with no change: only the state heartbeat is written, no notification", async () => {
    const w = world({
      includedUsed: 1900,
      vars: new Map([["a/CI_RUNS_ON", '["self-hosted"]'], ["b/CI_RUNS_ON", '["self-hosted"]'], ["a/OVERTIME_STATE", state("self-hosted")]]),
    });
    const { gh, calls } = fakeGitHub(w);
    const r = await run(withNotify(), NOW, gh);
    expect(r.decision).toMatchObject({ mode: "self-hosted", changed: false, percentUsed: 95 });
    expect(r.repos.map((x) => x.action)).toEqual(["unchanged", "unchanged"]);
    expect(writes(calls).map((c) => `${c.method} ${c.path}`)).toEqual(["PATCH /repos/me/a/actions/variables/OVERTIME_STATE"]);
    // since/reason describe how the mode was entered; only lastChecked moves.
    expect(JSON.parse(w.vars.get("a/OVERTIME_STATE")!)).toEqual({ mode: "self-hosted", cycle: "2026-09", since: "2026-09-01T00:00:00.000Z", reason: "earlier", trigger: "usage", lastChecked: NOW.toISOString() });
    expect(webhook).not.toHaveBeenCalled();
  });

  it("stays self-hosted for the rest of the cycle, then returns to hosted on a new cycle", async () => {
    const vars = new Map([["a/CI_RUNS_ON", '["self-hosted"]'], ["b/CI_RUNS_ON", '["self-hosted"]'], ["a/OVERTIME_STATE", state("self-hosted", "2026-09")]]);
    const same = fakeGitHub(world({ includedUsed: 10, vars }));
    expect((await run(config(), NOW, same.gh)).decision).toMatchObject({ mode: "self-hosted", changed: false });
    expect(writes(same.calls).map((c) => c.path)).toEqual(["/repos/me/a/actions/variables/OVERTIME_STATE"]);

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
      decision: { mode: "hosted", reason: "5% used", percentUsed: 5, changed: false, refusals: [] },
      usage: { grossMinutes: 100, includedUsed: 100, billedMinutes: 0, billedAmount: 0, cycle: "2026-09", source: "summary" },
      refusals: [], repos: [], reruns: [], warnings: ["no repositories matched the selection"], includedMinutes: 2000,
    }, cfg);
    expect(md).toContain("## ⏱️ Overtime: ☁️ GitHub-hosted (dry run)");
    expect(md).toContain("| (none) | | | |");
    expect(md).toContain("**Warnings:**\n- no repositories matched the selection");
    expect(md).not.toContain("Refused jobs");
  });
});

const HEURISTIC_JOB = { id: 1, name: "build", message: "", labels: ["ubuntu-latest"] };
const reruns = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/rerun-failed-jobs")).map((c) => c.path.split("/")[6]);
const saved = (w: World): State => JSON.parse(w.vars.get("a/OVERTIME_STATE")!) as State;

describe("run: refusal evidence (#9)", () => {
  it("a single heuristic refusal at low usage is ignored: stays hosted, nothing re-run", async () => {
    const w = world({ includedUsed: 100, annotations403: true, runs: { a: [{ id: 11, jobs: [HEURISTIC_JOB] }] } });
    const { gh, calls } = fakeGitHub(w);
    const r = await run(config(), NOW, gh);
    expect(r.refusals.map((x) => x.evidence)).toEqual(["heuristic"]);
    expect(r.decision).toMatchObject({ mode: "hosted", refusals: [] });
    expect(r.decision.reason).toMatch(/ignoring 1 unconfirmed refusal/);
    expect(reruns(calls)).toEqual([]);
  });

  it("enough heuristic refusals at high usage switch and are re-run", async () => {
    const w = world({ includedUsed: 1700, annotations403: true, runs: { a: [{ id: 11, jobs: [HEURISTIC_JOB] }, { id: 12, jobs: [{ ...HEURISTIC_JOB, id: 2 }] }] } });
    const { gh, calls } = fakeGitHub(w);
    const r = await run(config(), NOW, gh);
    expect(r.decision).toMatchObject({ mode: "self-hosted", trigger: "refusal" });
    expect(reruns(calls)).toEqual(["11", "12"]);
    expect(saved(w)).toMatchObject({ trigger: "refusal", reran: [11, 12] });
  });

  it("a refusal-driven switch returns to hosted once the refusals clear", async () => {
    const w = world({ includedUsed: 100, runs: { a: [{ id: 11, jobs: [{ id: 1, name: "build", message: BILLING_MSG }] }] } });
    const first = fakeGitHub(w);
    expect((await run(config(), NOW, first.gh)).decision).toMatchObject({ mode: "self-hosted", trigger: "refusal" });
    w.runs = {}; // out of the lookback window (or it was never a billing problem)
    const second = fakeGitHub(w);
    const r = await run(withNotify(), new Date(NOW.getTime() + 600_000), second.gh);
    expect(r.decision).toMatchObject({ mode: "hosted", changed: true });
    expect(r.decision.reason).toMatch(/^billing refusals cleared/);
    expect(w.vars.get("a/CI_RUNS_ON")).toBe('"ubuntu-latest"');
    expect(saved(w)).toMatchObject({ mode: "hosted", reran: [11] });
    expect(saved(w)).not.toHaveProperty("trigger");
  });
});

describe("run: re-run limits (#9)", () => {
  const refused = (ids: number[]) => ({ a: ids.map((id) => ({ id, jobs: [{ id, name: `job${id}`, message: BILLING_MSG }] })) });

  it("never re-runs the same run id twice across invocations (ids persist in state)", async () => {
    const w = world({ runs: refused([11]) });
    const first = fakeGitHub(w);
    expect((await run(config(), NOW, first.gh)).reruns).toEqual([11]);
    expect(saved(w).reran).toEqual([11]);

    // The re-run was refused again: same run id, still in the lookback window.
    const second = fakeGitHub(w);
    const r = await run(config(), new Date(NOW.getTime() + 600_000), second.gh);
    expect(r.decision.mode).toBe("self-hosted");
    expect(r.reruns).toEqual([]);
    expect(reruns(second.calls)).toEqual([]);
    expect(saved(w).reran).toEqual([11]);
  });

  it("caps re-runs per invocation at max-reruns and picks up the rest next time", async () => {
    const w = world({ runs: refused([11, 12, 13]) });
    const first = fakeGitHub(w);
    const r1 = await run(config({ maxReruns: 2 }), NOW, first.gh);
    expect(r1.reruns).toEqual([11, 12]);
    expect(r1.warnings).toContain("re-run cap reached (max-reruns: 2); 1 refused run(s) left for the next run");
    expect(saved(w).reran).toEqual([11, 12]);

    const second = fakeGitHub(w);
    const r2 = await run(config({ maxReruns: 2 }), new Date(NOW.getTime() + 600_000), second.gh);
    expect(r2.reruns).toEqual([13]);
    expect(r2.warnings).toEqual([]);
    expect(saved(w).reran).toEqual([11, 12, 13]);
  });

  it("max-reruns 0 re-runs nothing", async () => {
    const { gh, calls } = fakeGitHub(world({ runs: refused([11]) }));
    const r = await run(config({ maxReruns: 0 }), NOW, gh);
    expect(r.reruns).toEqual([]);
    expect(reruns(calls)).toEqual([]);
  });

  it("keeps only the last 100 re-run ids", async () => {
    const old = Array.from({ length: 100 }, (_, i) => 1000 + i);
    const vars = new Map([["a/OVERTIME_STATE", JSON.stringify({ mode: "self-hosted", cycle: "2026-09", since: "x", reason: "earlier", reran: old })]]);
    const w = world({ vars, runs: refused([11]) });
    const { gh } = fakeGitHub(w);
    await run(config(), NOW, gh);
    const ids = saved(w).reran!;
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe(1001);
    expect(ids.at(-1)).toBe(11);
  });
});

describe("run: heartbeat and token expiry (#10)", () => {
  it("writes lastChecked on every non-dry run, even when nothing changed", async () => {
    const w = world({ includedUsed: 100 });
    await run(config(), NOW, fakeGitHub(w).gh);
    expect(saved(w).lastChecked).toBe(NOW.toISOString());
    const later = new Date(NOW.getTime() + 600_000);
    const second = fakeGitHub(w);
    const r = await run(withNotify(), later, second.gh);
    expect(r.decision.changed).toBe(false);
    expect(saved(w)).toMatchObject({ lastChecked: later.toISOString(), since: NOW.toISOString() });
    expect(webhook).not.toHaveBeenCalled(); // still only notifies on mode change
  });

  it("warns when the token expires soon and notifies once per UTC day", async () => {
    const vars = new Map([["a/CI_RUNS_ON", '"ubuntu-latest"'], ["b/CI_RUNS_ON", '"ubuntu-latest"'], ["a/OVERTIME_STATE", state("hosted")]]);
    const w = world({ vars, tokenExpires: "2026-09-20 00:00:00 UTC" });

    const r1 = await run(withNotify(), NOW, fakeGitHub(w).gh);
    const warning = "the GitHub token expires in 5 day(s), on 2026-09-20 (2026-09-20T00:00:00.000Z); rotate it and update the secret before then";
    expect(r1.warnings).toEqual([warning]);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(JSON.parse((webhook.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({
      event: "overtime.token_expiring", daysLeft: 5, expiresOn: "2026-09-20", owner: "me",
      text: `${warning}. When it expires, CI_RUNS_ON stops being managed.`,
    });
    expect(saved(w).tokenWarnedOn).toBe("2026-09-15");

    // Same UTC day: warning again, no second notification.
    const r2 = await run(withNotify(), new Date("2026-09-15T23:50:00Z"), fakeGitHub(w).gh);
    expect(r2.warnings).toHaveLength(1);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(saved(w).tokenWarnedOn).toBe("2026-09-15");

    // Next UTC day: one more.
    await run(withNotify(), new Date("2026-09-16T00:10:00Z"), fakeGitHub(w).gh);
    expect(webhook).toHaveBeenCalledTimes(2);
    expect(saved(w).tokenWarnedOn).toBe("2026-09-16");
  });

  it("does not record the day when the notification failed, so it retries", async () => {
    webhook.mockImplementation(async () => new Response("no", { status: 500 }));
    const w = world({ vars: new Map([["a/OVERTIME_STATE", state("hosted")]]), tokenExpires: "2026-09-20 00:00:00 UTC" });
    const r = await run(withNotify(), NOW, fakeGitHub(w).gh);
    expect(r.warnings).toContain("generic webhook -> 500");
    expect(saved(w)).not.toHaveProperty("tokenWarnedOn");
  });

  it("no warning outside the window, when disabled, or without the header", async () => {
    const far = await run(config(), NOW, fakeGitHub(world({ tokenExpires: "2026-10-30 00:00:00 UTC" })).gh);
    expect(far.warnings).toEqual([]);
    const off = await run(config({ tokenExpiryWarnDays: 0 }), NOW, fakeGitHub(world({ tokenExpires: "2026-09-16 00:00:00 UTC" })).gh);
    expect(off.warnings).toEqual([]);
    const none = await run(config(), NOW, fakeGitHub(world()).gh);
    expect(none.warnings).toEqual([]);
  });

  it("without notify targets it only warns and records nothing", async () => {
    const w = world({ tokenExpires: "2026-09-20 00:00:00 UTC" });
    const r = await run(config(), NOW, fakeGitHub(w).gh);
    expect(r.warnings).toHaveLength(1);
    expect(webhook).not.toHaveBeenCalled();
    expect(saved(w)).not.toHaveProperty("tokenWarnedOn");
  });

  it("dry runs warn but neither notify nor write", async () => {
    const w = world({ vars: new Map([["a/OVERTIME_STATE", state("hosted")]]), tokenExpires: "2026-09-20 00:00:00 UTC" });
    const { gh, calls } = fakeGitHub(w);
    const r = await run(withNotify({ dryRun: true }), NOW, gh);
    expect(r.warnings).toHaveLength(1);
    expect(webhook).not.toHaveBeenCalled();
    expect(writes(calls)).toEqual([]);
  });
});

describe("tokenExpiryWarning", () => {
  it("reports days left (rounded up), the date, and expired tokens", () => {
    expect(tokenExpiryWarning(new Date("2026-09-29T00:00:00Z"), NOW, 14)).toMatchObject({ daysLeft: 14, date: "2026-09-29" });
    expect(tokenExpiryWarning(new Date("2026-09-29T12:00:01Z"), NOW, 14)).toBeUndefined();
    expect(tokenExpiryWarning(new Date("2026-09-15T13:00:00Z"), NOW, 14)).toMatchObject({ daysLeft: 1 });
    expect(tokenExpiryWarning(new Date("2026-09-10T00:00:00Z"), NOW, 14)!.text).toBe("the GitHub token expired on 2026-09-10; create a new one and update the secret");
    expect(tokenExpiryWarning(undefined, NOW, 14)).toBeUndefined();
    expect(tokenExpiryWarning(new Date("2026-09-16T00:00:00Z"), NOW, 0)).toBeUndefined();
  });
});

describe("watchdog (#10)", () => {
  const withState = (st: object | undefined) => world({ vars: st ? new Map([["a/OVERTIME_STATE", JSON.stringify(st)]]) : new Map() });
  const base = { mode: "self-hosted", cycle: "2026-09", since: "2026-09-01T00:00:00.000Z", reason: "earlier" };
  const wd = (over: Partial<Config> = {}) => withNotify({ watchdog: true, ...over });

  it("fresh state: ok, no writes, no notification", async () => {
    const { gh, calls } = fakeGitHub(withState({ ...base, lastChecked: "2026-09-15T11:50:00.000Z" }));
    const r = await watchdog(wd(), NOW, gh);
    expect(r).toMatchObject({ ok: true, minutesSince: 10 });
    expect(r.message).toBe("OK: Overtime last ran 10 minute(s) ago (2026-09-15T11:50:00.000Z); CI_RUNS_ON is self-hosted");
    expect(writes(calls)).toEqual([]);
    expect(calls.map((c) => c.path)).toEqual(["/repos/me/a/actions/variables/OVERTIME_STATE"]);
    expect(webhook).not.toHaveBeenCalled();
    expect(watchdogSummaryMarkdown(r)).toContain("✅ running");
  });

  it("exactly at stale-after-minutes is still fresh", async () => {
    const { gh } = fakeGitHub(withState({ ...base, lastChecked: "2026-09-15T11:00:00.000Z" }));
    expect((await watchdog(wd(), NOW, gh)).ok).toBe(true);
  });

  it("stale state: not ok, notifies, writes nothing", async () => {
    const { gh, calls } = fakeGitHub(withState({ ...base, lastChecked: "2026-09-15T10:30:00.000Z" }));
    const r = await watchdog(wd(), NOW, gh);
    expect(r).toMatchObject({ ok: false, minutesSince: 90 });
    expect(r.message).toBe("Overtime hasn't run for 90 minutes; CI_RUNS_ON is frozen at self-hosted");
    expect(writes(calls)).toEqual([]);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(JSON.parse((webhook.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({
      event: "overtime.stale", text: r.message, mode: "self-hosted", minutesSince: 90, staleAfterMinutes: 60,
    });
    expect(watchdogSummaryMarkdown(r)).toContain("❌ stale");
  });

  it("honours stale-after-minutes and the variable name", async () => {
    const { gh } = fakeGitHub(withState({ ...base, lastChecked: "2026-09-15T10:30:00.000Z" }));
    expect((await watchdog(wd({ staleAfterMinutes: 120 }), NOW, gh)).ok).toBe(true);
    const r = await watchdog(wd({ staleAfterMinutes: 30, variable: "RUNS_ON" }), NOW, fakeGitHub(withState({ ...base, lastChecked: "2026-09-15T10:30:00.000Z" })).gh);
    expect(r.message).toBe("Overtime hasn't run for 90 minutes; RUNS_ON is frozen at self-hosted");
  });

  it("state without lastChecked (written by an older Overtime) is stale", async () => {
    const { gh, calls } = fakeGitHub(withState(base));
    const r = await watchdog(wd(), NOW, gh);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/hasn't recorded when it last ran .* CI_RUNS_ON is frozen at self-hosted$/);
    expect(writes(calls)).toEqual([]);
    expect(webhook).toHaveBeenCalledTimes(1);
  });

  it("missing state: not ok, notifies, writes nothing", async () => {
    const { gh, calls } = fakeGitHub(withState(undefined));
    const r = await watchdog(wd(), NOW, gh);
    expect(r.ok).toBe(false);
    expect(r.state).toBeUndefined();
    expect(r.message).toBe("Overtime has no state in me/a variable OVERTIME_STATE; it may never have run, and CI_RUNS_ON is not being managed");
    expect(writes(calls)).toEqual([]);
    expect(JSON.parse((webhook.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ event: "overtime.stale", mode: null, lastChecked: null });
  });

  it("surfaces webhook failures and token expiry as warnings", async () => {
    webhook.mockImplementation(async () => new Response("no", { status: 500 }));
    const w = withState(base); // a 200 response, so it carries the expiry header
    w.tokenExpires = "2026-09-20 00:00:00 UTC";
    const r = await watchdog(wd(), NOW, fakeGitHub(w).gh);
    expect(r.warnings).toEqual([expect.stringMatching(/token expires in 5 day/), "generic webhook -> 500"]);
  });

  it("throws when the state can't be read (e.g. no access), rather than reporting healthy", async () => {
    const { gh } = client(() => ({ status: 403, body: { message: "forbidden" } }), 0);
    await expect(watchdog(wd(), NOW, gh)).rejects.toThrow(/403/);
  });

  it("run() refuses to act in watchdog mode, so it can never decide or write", async () => {
    const { gh, calls } = fakeGitHub(world());
    await expect(run(config({ watchdog: true }), NOW, gh)).rejects.toThrow(/watchdog/);
    expect(calls).toEqual([]);
  });
});
