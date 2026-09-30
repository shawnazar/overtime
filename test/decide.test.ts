import { describe, it, expect } from "vitest";
import { decide, parseState, type State } from "../src/decide.js";
import type { Usage } from "../src/usage.js";
import type { Refusal } from "../src/refusals.js";
import { DEFAULTS } from "../src/config.js";

const cfg = (over: Partial<typeof DEFAULTS> = {}) => ({ ...DEFAULTS, includedMinutes: 2000, includedMinutesAuto: false, ...over });
const usage = (includedUsed: number, over: Partial<Usage> = {}): Usage => ({
  grossMinutes: includedUsed, includedUsed, billedMinutes: 0, billedAmount: 0, cycle: "2026-09", source: "summary", ...over,
});
const state = (mode: State["mode"], cycle = "2026-09"): State => ({ mode, cycle, since: "2026-09-10T00:00:00Z", reason: "earlier reason" });
const refusal: Refusal = { repo: "a", runId: 42, jobName: "build", reason: "The job was not started because your account has hit its spending limit" };

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
