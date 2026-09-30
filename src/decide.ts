import type { Config, Mode } from "./config.js";
import type { Usage } from "./usage.js";
import type { Refusal } from "./refusals.js";

/** What put Overtime in its current mode. Only usage and overage are sticky for the cycle. */
export type Trigger = "usage" | "overage" | "refusal" | "force";

export interface State {
  mode: Mode;
  cycle: string;
  since: string; // ISO time the mode was entered
  reason: string;
  /** Absent in state written before v0.2; inferred from `reason` (see triggerOf). */
  trigger?: Trigger;
  /** ISO time of the last non-dry run, written every run; the watchdog reads it. */
  lastChecked?: string;
  /** Run ids already re-run (most recent last, at most RERAN_KEEP), so a run is never re-run twice. */
  reran?: number[];
  /** UTC day (YYYY-MM-DD) the token-expiry notification was last sent. */
  tokenWarnedOn?: string;
}

export const RERAN_KEEP = 100;

export interface Decision {
  mode: Mode;
  reason: string;
  percentUsed: number;
  changed: boolean;
  /** Why the mode is what it is; undefined for plain "hosted, under the threshold". */
  trigger?: Trigger;
  /** Refusals that counted toward the decision (only these are re-run). */
  refusals: Refusal[];
}

type DecideConfig = Pick<Config,
  "mode" | "includedMinutes" | "switchAtPercent" | "switchBack" | "switchBackPercent" | "switchOnOverage" | "refusalMinCount" | "refusalMinPercent">;

/**
 * Which refusals count. Annotation evidence is GitHub's own billing message: one is enough.
 * Heuristic evidence ("hosted job never got a runner") also matches outages and typo'd labels, so it
 * counts only when there are at least refusalMinCount of them AND usage is already high
 * (percentUsed >= refusalMinPercent, 0 disabling the floor, or minutes are being billed).
 */
export function countedRefusals(
  cfg: Pick<Config, "refusalMinCount" | "refusalMinPercent">, refusals: Refusal[], percentUsed: number, billedMinutes: number,
): { counted: Refusal[]; ignored: Refusal[] } {
  const annotation = refusals.filter((r) => r.evidence !== "heuristic");
  const heuristic = refusals.filter((r) => r.evidence === "heuristic");
  const usageHigh = percentUsed >= cfg.refusalMinPercent || billedMinutes > 0;
  const heuristicCounts = heuristic.length > 0 && heuristic.length >= cfg.refusalMinCount && usageHigh;
  return heuristicCounts ? { counted: refusals, ignored: [] } : { counted: annotation, ignored: heuristic };
}

/** Trigger of a saved state; older state has none, so read it from the reason it was saved with. */
export function triggerOf(s: State): Trigger {
  if (s.trigger) return s.trigger;
  if (/^GitHub refused /.test(s.reason)) return "refusal";
  if (/^forced by /.test(s.reason)) return "force";
  if (/minute\(s\) billed this cycle/.test(s.reason)) return "overage";
  return "usage";
}

const sticky = (t: Trigger | undefined) => t === "usage" || t === "overage";

/**
 * Pure: everything that decides the mode, in priority order.
 *  1. Manual force (force variable, then `mode` setting).
 *  2. Evidence GitHub stopped running hosted jobs (counted refusals) or started billing (overage).
 *  3. Included minutes used >= switch-at-percent.
 *  4. Hysteresis, for usage/overage switches only: stay self-hosted until the next cycle (default) or
 *     until usage drops below switch-back-percent. A refusal- or force-driven switch lasts only while
 *     its cause does.
 *  5. Otherwise hosted.
 */
export function decide(args: {
  cfg: DecideConfig;
  usage: Usage;
  refusals: Refusal[];
  previous?: State;
  force?: string;
}): Decision {
  const { cfg, usage, refusals, previous, force } = args;
  const percentUsed = cfg.includedMinutes > 0 ? Math.round((usage.includedUsed / cfg.includedMinutes) * 1000) / 10 : 100;
  const sameCycle = previous?.cycle === usage.cycle;
  const { counted, ignored } = countedRefusals(cfg, refusals, percentUsed, usage.billedMinutes);
  const make = (mode: Mode, reason: string, trigger: Trigger | undefined, used: Refusal[] = []): Decision =>
    ({ mode, reason, percentUsed, changed: mode !== previous?.mode, trigger, refusals: used });
  const note = ignored.length
    ? ` (ignoring ${ignored.length} unconfirmed refusal(s): heuristic evidence needs ${cfg.refusalMinCount}+ and ${cfg.refusalMinPercent}%+ used or billed minutes)`
    : "";

  const forced = (force ?? "").trim().toLowerCase();
  if (forced === "hosted" || forced === "self-hosted") return make(forced, `forced by variable (${forced})`, "force");
  if (cfg.mode !== "auto") return make(cfg.mode, `forced by config (mode: ${cfg.mode})`, "force");

  if (counted.length) {
    const r = counted[0]!;
    return make("self-hosted", `GitHub refused ${counted.length} hosted job(s), e.g. ${r.repo} run ${r.runId}: ${r.reason}`, "refusal", counted);
  }
  if (cfg.switchOnOverage && usage.billedMinutes > 0) {
    return make("self-hosted", `${usage.billedMinutes} Actions minute(s) billed this cycle; included minutes are spent${note}`, "overage");
  }
  if (percentUsed >= cfg.switchAtPercent) {
    return make("self-hosted", `${percentUsed}% of ${cfg.includedMinutes} included minutes used (threshold ${cfg.switchAtPercent}%)${note}`, "usage");
  }
  if (previous?.mode === "self-hosted" && sameCycle) {
    const t = triggerOf(previous);
    if (t === "refusal") {
      return make("hosted", `billing refusals cleared: none counted in the lookback window and ${percentUsed}% used is under ${cfg.switchAtPercent}%; back to GitHub-hosted${note}`, undefined);
    }
    if (t === "force") {
      return make("hosted", `force removed: ${percentUsed}% used is under ${cfg.switchAtPercent}%; back to GitHub-hosted${note}`, undefined);
    }
    if (cfg.switchBack === "next-cycle") return make("self-hosted", `staying self-hosted until the billing cycle resets (${previous.reason})${note}`, t);
    if (percentUsed >= cfg.switchBackPercent) {
      return make("self-hosted", `${percentUsed}% used; switch back below ${cfg.switchBackPercent}%${note}`, t);
    }
  }
  return make("hosted", (previous?.mode === "self-hosted" && !sameCycle
    ? `new billing cycle ${usage.cycle}: back to GitHub-hosted (${percentUsed}% used)`
    : `${percentUsed}% of ${cfg.includedMinutes} included minutes used`) + note, undefined);
}

/**
 * Pure: the state to persist after a decision. `since`, `reason` and `trigger` describe how the current
 * mode was entered, so they only move when the mode, the cycle or the (sticky) cause changes.
 */
export function nextState(args: {
  previous?: State;
  decision: Decision;
  cycle: string;
  now: Date;
  reran?: number[];
  tokenWarnedOn?: string;
}): State {
  const { previous, decision, cycle, now } = args;
  const fresh = !previous || decision.changed || previous.cycle !== cycle;
  const prevTrigger = previous ? triggerOf(previous) : undefined;
  // Keep a sticky cause (e.g. usage crossed the threshold, then a force pinned the same mode) so that
  // removing the force doesn't lose the cycle's hysteresis.
  const trigger = fresh || !sticky(prevTrigger) ? decision.trigger : prevTrigger;
  const reasonMoves = fresh || trigger !== prevTrigger;
  const s: State = {
    mode: decision.mode,
    cycle,
    since: decision.changed || !previous ? now.toISOString() : previous.since,
    reason: reasonMoves || !previous ? decision.reason : previous.reason,
    lastChecked: now.toISOString(),
  };
  if (trigger) s.trigger = trigger;
  const reran = [...(previous?.reran ?? []), ...(args.reran ?? [])].slice(-RERAN_KEEP);
  if (reran.length) s.reran = reran;
  const warned = args.tokenWarnedOn ?? previous?.tokenWarnedOn;
  if (warned) s.tokenWarnedOn = warned;
  return s;
}

const TRIGGERS: readonly string[] = ["usage", "overage", "refusal", "force"];

/** Tolerant: old state (no trigger/lastChecked/reran) parses; bad optional fields are dropped. */
export function parseState(raw: string | undefined): State | undefined {
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object" || (s.mode !== "hosted" && s.mode !== "self-hosted") || typeof s.cycle !== "string") return undefined;
    const out: State = {
      mode: s.mode, cycle: s.cycle,
      since: typeof s.since === "string" ? s.since : "",
      reason: typeof s.reason === "string" ? s.reason : "",
    };
    if (TRIGGERS.includes(s.trigger)) out.trigger = s.trigger;
    if (typeof s.lastChecked === "string" && !Number.isNaN(Date.parse(s.lastChecked))) out.lastChecked = s.lastChecked;
    if (Array.isArray(s.reran)) out.reran = s.reran.filter((n: unknown) => Number.isSafeInteger(n)).slice(-RERAN_KEEP);
    if (typeof s.tokenWarnedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.tokenWarnedOn)) out.tokenWarnedOn = s.tokenWarnedOn;
    return out;
  } catch { /* corrupt state: start fresh */ }
  return undefined;
}
