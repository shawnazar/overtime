import { describe, it, expect } from "vitest";
import { decide, parseState, nextState, countedRefusals, triggerOf, type State, type Decision } from "../src/decide.js";
import type { Usage } from "../src/usage.js";
import type { Refusal } from "../src/refusals.js";
import { DEFAULTS } from "../src/config.js";

const cfg = (over: Partial<typeof DEFAULTS> = {}) => ({ ...DEFAULTS, includedMinutes: 2000, includedMinutesAuto: false, ...over });
const usage = (includedUsed: number, over: Partial<Usage> = {}): Usage => ({
  grossMinutes: includedUsed, includedUsed, billedMinutes: 0, billedAmount: 0, cycle: "2026-09", source: "summary", ...over,
});
const state = (mode: State["mode"], cycle = "2026-09"): State => ({ mode, cycle, since: "2026-09-10T00:00:00Z", reason: "earlier reason" });
const refusal: Refusal = { repo: "a", runId: 42, jobName: "build", reason: "The job was not started because your account has hit its spending limit", evidence: "annotation" };

describe("decide: manual force", () => {
  it("force variable 'self-hosted' wins over everything, case/space-insensitive", () => {
    const d = decide({ cfg: cfg({ mode: "hosted" }), usage: usage(0), refusals: [], force: "  Self-Hosted \n" });
    expect(d.mode).toBe("self-hosted");
    expect(d.reason).toBe("forced by variable (self-hosted)");
  });

  it("force variable 'hosted' wins over refusals and overage", () => {
    const d = decide({ cfg: cfg(), usage: usage(2000, { billedMinutes: 50 }), refusals: [refusal], force: "hosted" });
    expect(d.mode).toBe("hosted");
    expect(d.reason).toMatch(/forced by variable/);
  });

  it("ignores an unrecognised force value", () => {
    const d = decide({ cfg: cfg(), usage: usage(0), refusals: [], force: "maybe" });
    expect(d.mode).toBe("hosted");
    expect(d.reason).not.toMatch(/forced/);
  });

  it("config mode forces when no force variable", () => {
    expect(decide({ cfg: cfg({ mode: "self-hosted" }), usage: usage(0), refusals: [] })).toMatchObject({
      mode: "self-hosted", reason: "forced by config (mode: self-hosted)",
    });
    expect(decide({ cfg: cfg({ mode: "hosted" }), usage: usage(2000), refusals: [refusal] })).toMatchObject({
      mode: "hosted", reason: "forced by config (mode: hosted)",
    });
  });
});

describe("decide: evidence", () => {
  it("refusals switch to self-hosted even at low usage", () => {
    const d = decide({ cfg: cfg(), usage: usage(10), refusals: [refusal, { ...refusal, runId: 43 }] });
    expect(d.mode).toBe("self-hosted");
    expect(d.reason).toContain("GitHub refused 2 hosted job(s), e.g. a run 42");
    expect(d.reason).toContain("spending limit");
  });

  it("overage switches when switchOnOverage is true", () => {
    const d = decide({ cfg: cfg({ switchOnOverage: true }), usage: usage(100, { billedMinutes: 3 }), refusals: [] });
    expect(d.mode).toBe("self-hosted");
    expect(d.reason).toMatch(/^3 Actions minute\(s\) billed/);
  });

  it("overage is ignored when switchOnOverage is false", () => {
    const d = decide({ cfg: cfg({ switchOnOverage: false }), usage: usage(100, { billedMinutes: 3 }), refusals: [] });
    expect(d.mode).toBe("hosted");
  });
});

describe("decide: percent threshold", () => {
  it("switches at exactly the threshold", () => {
    const d = decide({ cfg: cfg({ includedMinutes: 2000, switchAtPercent: 90 }), usage: usage(1800), refusals: [] });
    expect(d.percentUsed).toBe(90);
    expect(d.mode).toBe("self-hosted");
    expect(d.reason).toBe("90% of 2000 included minutes used (threshold 90%)");
  });

  it("stays hosted just below the threshold", () => {
    const d = decide({ cfg: cfg({ includedMinutes: 2000, switchAtPercent: 90 }), usage: usage(1798), refusals: [] });
    expect(d.percentUsed).toBe(89.9);
    expect(d.mode).toBe("hosted");
  });

  it("rounds percentUsed to one decimal", () => {
    expect(decide({ cfg: cfg({ includedMinutes: 3000 }), usage: usage(1000), refusals: [] }).percentUsed).toBe(33.3);
  });

  it("includedMinutes=0 is treated as 100% used", () => {
    const d = decide({ cfg: cfg({ includedMinutes: 0 }), usage: usage(0), refusals: [] });
    expect(d.percentUsed).toBe(100);
    expect(d.mode).toBe("self-hosted");
  });
});

describe("decide: hysteresis", () => {
  it("next-cycle: stays self-hosted in the same cycle even when usage is low", () => {
    const d = decide({ cfg: cfg({ switchBack: "next-cycle" }), usage: usage(10), refusals: [], previous: state("self-hosted") });
    expect(d.mode).toBe("self-hosted");
    expect(d.reason).toBe("staying self-hosted until the billing cycle resets (earlier reason)");
    expect(d.changed).toBe(false);
  });

  it("next-cycle: returns to hosted on a new cycle", () => {
    const d = decide({ cfg: cfg(), usage: usage(10, { cycle: "2026-10" }), refusals: [], previous: state("self-hosted", "2026-09") });
    expect(d.mode).toBe("hosted");
    expect(d.reason).toBe("new billing cycle 2026-10: back to GitHub-hosted (0.5% used)");
    expect(d.changed).toBe(true);
  });

  it("below-percent: stays self-hosted at or above switch-back-percent", () => {
    const c = cfg({ switchBack: "below-percent", switchBackPercent: 50, switchAtPercent: 90, includedMinutes: 2000 });
    const d = decide({ cfg: c, usage: usage(1000), refusals: [], previous: state("self-hosted") });
    expect(d.percentUsed).toBe(50);
    expect(d.mode).toBe("self-hosted");
    expect(d.reason).toBe("50% used; switch back below 50%");
  });

  it("below-percent: switches back to hosted below switch-back-percent", () => {
    const c = cfg({ switchBack: "below-percent", switchBackPercent: 50, switchAtPercent: 90, includedMinutes: 2000 });
    const d = decide({ cfg: c, usage: usage(998), refusals: [], previous: state("self-hosted") });
    expect(d.percentUsed).toBe(49.9);
    expect(d.mode).toBe("hosted");
    expect(d.changed).toBe(true);
  });

  it("previous hosted in the same cycle below threshold stays hosted", () => {
    const d = decide({ cfg: cfg(), usage: usage(100), refusals: [], previous: state("hosted") });
    expect(d).toMatchObject({ mode: "hosted", changed: false, reason: "5% of 2000 included minutes used" });
  });
});

describe("decide: changed flag", () => {
  it("is true with no previous state", () => {
    expect(decide({ cfg: cfg(), usage: usage(0), refusals: [] }).changed).toBe(true);
  });
  it("is false when the mode matches previous", () => {
    expect(decide({ cfg: cfg(), usage: usage(1900), refusals: [], previous: state("self-hosted") }).changed).toBe(false);
  });
  it("is true when the mode differs from previous", () => {
    expect(decide({ cfg: cfg(), usage: usage(1900), refusals: [], previous: state("hosted") }).changed).toBe(true);
  });
});

describe("parseState", () => {
  it("parses a valid state", () => {
    const s = state("self-hosted");
    expect(parseState(JSON.stringify(s))).toEqual(s);
  });
  it("returns undefined for empty/undefined", () => {
    expect(parseState(undefined)).toBeUndefined();
    expect(parseState("")).toBeUndefined();
  });
  it("returns undefined for corrupt JSON", () => {
    expect(parseState("{not json")).toBeUndefined();
  });
  it("returns undefined for the wrong shape", () => {
    expect(parseState(JSON.stringify({ mode: "sideways", cycle: "2026-09" }))).toBeUndefined();
    expect(parseState(JSON.stringify({ mode: "hosted", cycle: 202609 }))).toBeUndefined();
    expect(parseState(JSON.stringify({ mode: "hosted" }))).toBeUndefined();
    expect(parseState("null")).toBeUndefined();
    expect(parseState("42")).toBeUndefined();
    expect(parseState('"hosted"')).toBeUndefined();
  });
});

const heur = (runId: number): Refusal => ({ repo: "a", runId, jobName: "build", reason: "hosted job never started (ubuntu-latest): no runner, no steps", evidence: "heuristic" });
const stateWith = (over: Partial<State>): State => ({ ...state("self-hosted"), ...over });

describe("decide: refusal evidence (#9)", () => {
  it("a single annotation-evidenced refusal counts, even at low usage", () => {
    const d = decide({ cfg: cfg(), usage: usage(10), refusals: [refusal] });
    expect(d).toMatchObject({ mode: "self-hosted", trigger: "refusal", refusals: [refusal] });
  });

  it("heuristic refusals below refusal-min-count are ignored, even at high usage", () => {
    const d = decide({ cfg: cfg({ refusalMinCount: 2, refusalMinPercent: 80 }), usage: usage(1700), refusals: [heur(1)] });
    expect(d).toMatchObject({ mode: "hosted", refusals: [], trigger: undefined });
    expect(d.reason).toBe("85% of 2000 included minutes used (ignoring 1 unconfirmed refusal(s): heuristic evidence needs 2+ and 80%+ used or billed minutes)");
  });

  it("heuristic refusals below the refusal-min-percent floor are ignored", () => {
    const d = decide({ cfg: cfg(), usage: usage(1500), refusals: [heur(1), heur(2), heur(3)] });
    expect(d.percentUsed).toBe(75);
    expect(d).toMatchObject({ mode: "hosted", refusals: [] });
    expect(d.reason).toMatch(/ignoring 3 unconfirmed refusal/);
  });

  it("heuristic refusals count at min-count and min-percent", () => {
    const d = decide({ cfg: cfg(), usage: usage(1600), refusals: [heur(1), heur(2)] });
    expect(d).toMatchObject({ mode: "self-hosted", trigger: "refusal" });
    expect(d.refusals.map((r) => r.runId)).toEqual([1, 2]);
    expect(d.reason).toMatch(/^GitHub refused 2 hosted job\(s\)/);
  });

  it("billed minutes lift the percent floor", () => {
    const d = decide({ cfg: cfg({ switchOnOverage: false }), usage: usage(100, { billedMinutes: 1 }), refusals: [heur(1), heur(2)] });
    expect(d).toMatchObject({ mode: "self-hosted", trigger: "refusal" });
  });

  it("refusal-min-percent 0 disables the floor", () => {
    const d = decide({ cfg: cfg({ refusalMinPercent: 0 }), usage: usage(0), refusals: [heur(1), heur(2)] });
    expect(d).toMatchObject({ mode: "self-hosted", trigger: "refusal" });
  });

  it("refusal-min-count 1 lets one heuristic refusal count (the old behaviour, with the floor)", () => {
    expect(decide({ cfg: cfg({ refusalMinCount: 1, refusalMinPercent: 0 }), usage: usage(0), refusals: [heur(1)] }).mode).toBe("self-hosted");
  });

  it("with mixed evidence below the heuristic bar, only the annotated refusals count", () => {
    const d = decide({ cfg: cfg(), usage: usage(10), refusals: [heur(1), refusal] });
    expect(d.refusals).toEqual([refusal]);
    expect(d.reason).toMatch(/^GitHub refused 1 hosted job\(s\), e\.g\. a run 42/);
  });

  it("countedRefusals splits counted and ignored", () => {
    expect(countedRefusals({ refusalMinCount: 2, refusalMinPercent: 80 }, [heur(1), refusal], 90, 0)).toEqual({ counted: [refusal], ignored: [heur(1)] });
    expect(countedRefusals({ refusalMinCount: 2, refusalMinPercent: 80 }, [heur(1), heur(2), refusal], 90, 0).counted).toHaveLength(3);
    expect(countedRefusals({ refusalMinCount: 2, refusalMinPercent: 80 }, [], 90, 0)).toEqual({ counted: [], ignored: [] });
  });
});

describe("decide: stickiness depends on the trigger (#9)", () => {
  it("a refusal-triggered switch returns to hosted once refusals clear and usage is under the threshold", () => {
    const d = decide({ cfg: cfg(), usage: usage(100), refusals: [], previous: stateWith({ trigger: "refusal" }) });
    expect(d).toMatchObject({ mode: "hosted", changed: true, trigger: undefined });
    expect(d.reason).toBe("billing refusals cleared: none counted in the lookback window and 5% used is under 90%; back to GitHub-hosted");
  });

  it("a refusal-triggered switch also clears when the remaining refusals don't count", () => {
    const d = decide({ cfg: cfg(), usage: usage(100), refusals: [heur(1)], previous: stateWith({ trigger: "refusal" }) });
    expect(d.mode).toBe("hosted");
    expect(d.reason).toMatch(/^billing refusals cleared.*ignoring 1 unconfirmed/);
  });

  it("a refusal-triggered switch stays while refusals keep counting", () => {
    const d = decide({ cfg: cfg(), usage: usage(100), refusals: [refusal], previous: stateWith({ trigger: "refusal" }) });
    expect(d).toMatchObject({ mode: "self-hosted", changed: false, trigger: "refusal" });
  });

  it("a refusal-triggered switch stays when usage has since crossed the threshold", () => {
    const d = decide({ cfg: cfg(), usage: usage(1900), refusals: [], previous: stateWith({ trigger: "refusal" }) });
    expect(d).toMatchObject({ mode: "self-hosted", trigger: "usage" });
  });

  it("legacy state from a refusal (no trigger field) is read from its reason and clears too", () => {
    const legacy = stateWith({ reason: "GitHub refused 1 hosted job(s), e.g. a run 1: hosted job never started" });
    expect(decide({ cfg: cfg(), usage: usage(100), refusals: [], previous: legacy }).mode).toBe("hosted");
  });

  it("a usage-triggered switch stays sticky until the next cycle", () => {
    const d = decide({ cfg: cfg(), usage: usage(10), refusals: [], previous: stateWith({ trigger: "usage" }) });
    expect(d).toMatchObject({ mode: "self-hosted", changed: false, trigger: "usage" });
    expect(d.reason).toMatch(/^staying self-hosted until the billing cycle resets/);
  });

  it("an overage-triggered switch stays sticky (below-percent hysteresis still applies)", () => {
    const c = cfg({ switchBack: "below-percent", switchBackPercent: 50, switchOnOverage: false });
    expect(decide({ cfg: c, usage: usage(1200), refusals: [], previous: stateWith({ trigger: "overage" }) })).toMatchObject({ mode: "self-hosted", trigger: "overage" });
    expect(decide({ cfg: c, usage: usage(100), refusals: [], previous: stateWith({ trigger: "overage" }) }).mode).toBe("hosted");
  });

  it("a force-triggered self-hosted returns to hosted when the force is removed", () => {
    const d = decide({ cfg: cfg(), usage: usage(100), refusals: [], previous: stateWith({ trigger: "force" }) });
    expect(d.mode).toBe("hosted");
    expect(d.reason).toMatch(/^force removed/);
  });

  it("refusal and force triggers still reset on a new cycle like any other", () => {
    const d = decide({ cfg: cfg(), usage: usage(10, { cycle: "2026-10" }), refusals: [], previous: stateWith({ trigger: "refusal" }) });
    expect(d.reason).toMatch(/^new billing cycle 2026-10/);
  });

  it("sets the trigger for each branch", () => {
    expect(decide({ cfg: cfg(), usage: usage(0), refusals: [], force: "self-hosted" }).trigger).toBe("force");
    expect(decide({ cfg: cfg({ mode: "hosted" }), usage: usage(0), refusals: [] }).trigger).toBe("force");
    expect(decide({ cfg: cfg(), usage: usage(10, { billedMinutes: 2 }), refusals: [] }).trigger).toBe("overage");
    expect(decide({ cfg: cfg(), usage: usage(1900), refusals: [] }).trigger).toBe("usage");
    expect(decide({ cfg: cfg(), usage: usage(10), refusals: [] }).trigger).toBeUndefined();
  });
});

describe("triggerOf", () => {
  it("prefers the stored trigger, else infers from the reason", () => {
    expect(triggerOf(stateWith({ trigger: "force", reason: "GitHub refused" }))).toBe("force");
    expect(triggerOf(stateWith({ reason: "GitHub refused 2 hosted job(s)" }))).toBe("refusal");
    expect(triggerOf(stateWith({ reason: "forced by variable (self-hosted)" }))).toBe("force");
    expect(triggerOf(stateWith({ reason: "3 Actions minute(s) billed this cycle; included minutes are spent" }))).toBe("overage");
    expect(triggerOf(stateWith({ reason: "95% of 2000 included minutes used (threshold 90%)" }))).toBe("usage");
  });
});

describe("nextState", () => {
  const NOW = new Date("2026-09-15T12:00:00Z");
  const dec = (over: Partial<Decision>): Decision => ({ mode: "self-hosted", reason: "now", percentUsed: 95, changed: false, trigger: "usage", refusals: [], ...over });

  it("first state: everything from the decision", () => {
    expect(nextState({ decision: dec({ changed: true }), cycle: "2026-09", now: NOW })).toEqual({
      mode: "self-hosted", cycle: "2026-09", since: NOW.toISOString(), reason: "now", trigger: "usage", lastChecked: NOW.toISOString(),
    });
  });

  it("unchanged mode: keeps since/reason/trigger, moves lastChecked, carries reran and tokenWarnedOn", () => {
    const prev = stateWith({ trigger: "usage", reran: [1], tokenWarnedOn: "2026-09-14", lastChecked: "2026-09-15T11:50:00Z" });
    expect(nextState({ previous: prev, decision: dec({ reason: "staying" }), cycle: "2026-09", now: NOW, reran: [2] })).toEqual({
      ...prev, lastChecked: NOW.toISOString(), reran: [1, 2],
    });
  });

  it("a force over a usage switch keeps the sticky usage trigger", () => {
    const prev = stateWith({ trigger: "usage" });
    const s = nextState({ previous: prev, decision: dec({ trigger: "force", reason: "forced by variable (self-hosted)" }), cycle: "2026-09", now: NOW });
    expect(s).toMatchObject({ trigger: "usage", reason: prev.reason });
  });

  it("usage crossing the threshold after a refusal switch upgrades the trigger and reason", () => {
    const prev = stateWith({ trigger: "refusal", reason: "GitHub refused 1" });
    const s = nextState({ previous: prev, decision: dec({ trigger: "usage", reason: "95% used" }), cycle: "2026-09", now: NOW });
    expect(s).toMatchObject({ trigger: "usage", reason: "95% used", since: prev.since });
  });

  it("a new cycle refreshes reason and trigger; hosted without a trigger stores none", () => {
    const s = nextState({ previous: stateWith({ trigger: "usage" }), decision: dec({ mode: "hosted", changed: true, trigger: undefined, reason: "new cycle" }), cycle: "2026-10", now: NOW });
    expect(s).toMatchObject({ mode: "hosted", cycle: "2026-10", reason: "new cycle", since: NOW.toISOString() });
    expect(s).not.toHaveProperty("trigger");
  });

  it("keeps only the newest 100 re-run ids and the newest tokenWarnedOn", () => {
    const prev = stateWith({ reran: Array.from({ length: 100 }, (_, i) => i), tokenWarnedOn: "2026-09-14" });
    const s = nextState({ previous: prev, decision: dec({}), cycle: "2026-09", now: NOW, reran: [500, 501], tokenWarnedOn: "2026-09-15" });
    expect(s.reran).toHaveLength(100);
    expect(s.reran!.slice(0, 1)).toEqual([2]);
    expect(s.reran!.slice(-2)).toEqual([500, 501]);
    expect(s.tokenWarnedOn).toBe("2026-09-15");
  });
});

describe("parseState: backward compatibility", () => {
  it("parses state written before trigger/lastChecked/reran existed", () => {
    const old = { mode: "self-hosted", cycle: "2026-09", since: "2026-09-10T00:00:00Z", reason: "95% used" };
    expect(parseState(JSON.stringify(old))).toEqual(old);
  });

  it("round-trips the new fields", () => {
    const s: State = { ...state("hosted"), trigger: "refusal", lastChecked: "2026-09-15T12:00:00.000Z", reran: [1, 2], tokenWarnedOn: "2026-09-15" };
    expect(parseState(JSON.stringify(s))).toEqual(s);
  });

  it("drops malformed optional fields instead of rejecting the state", () => {
    const s = parseState(JSON.stringify({ ...state("hosted"), trigger: "vibes", lastChecked: "yesterday", reran: [1, "2", 3.5, 4], tokenWarnedOn: "Sept 15" }));
    expect(s).toEqual({ ...state("hosted"), reran: [1, 4] });
  });
});
