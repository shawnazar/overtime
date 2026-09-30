import type { Config, Mode } from "./config.js";
import type { Usage } from "./usage.js";
import type { Refusal } from "./refusals.js";

export interface State {
  mode: Mode;
  cycle: string;
  since: string; // ISO time the mode was entered
  reason: string;
}

export interface Decision {
  mode: Mode;
  reason: string;
  percentUsed: number;
  changed: boolean;
}

/**
 * Pure: everything that decides the mode, in priority order.
 *  1. Manual force (force variable, then `mode` setting).
 *  2. Evidence GitHub stopped running hosted jobs (refusals) or started billing (overage).
 *  3. Included minutes used >= switch-at-percent.
 *  4. Hysteresis: stay self-hosted until the next cycle (default) or until usage drops below
 *     switch-back-percent (only possible if the allowance was raised).
 *  5. Otherwise hosted.
 */
export function decide(args: {
  cfg: Pick<Config, "mode" | "includedMinutes" | "switchAtPercent" | "switchBack" | "switchBackPercent" | "switchOnOverage">;
  usage: Usage;
  refusals: Refusal[];
  previous?: State;
  force?: string;
}): Decision {
  const { cfg, usage, refusals, previous, force } = args;
  const percentUsed = cfg.includedMinutes > 0 ? Math.round((usage.includedUsed / cfg.includedMinutes) * 1000) / 10 : 100;
  const sameCycle = previous?.cycle === usage.cycle;
  const make = (mode: Mode, reason: string): Decision => ({ mode, reason, percentUsed, changed: mode !== previous?.mode });

  const forced = (force ?? "").trim().toLowerCase();
  if (forced === "hosted" || forced === "self-hosted") return make(forced, `forced by variable (${forced})`);
  if (cfg.mode !== "auto") return make(cfg.mode, `forced by config (mode: ${cfg.mode})`);

  if (refusals.length) {
    const r = refusals[0]!;
    return make("self-hosted", `GitHub refused ${refusals.length} hosted job(s), e.g. ${r.repo} run ${r.runId}: ${r.reason}`);
  }
  if (cfg.switchOnOverage && usage.billedMinutes > 0) {
    return make("self-hosted", `${usage.billedMinutes} Actions minute(s) billed this cycle; included minutes are spent`);
  }
  if (percentUsed >= cfg.switchAtPercent) {
    return make("self-hosted", `${percentUsed}% of ${cfg.includedMinutes} included minutes used (threshold ${cfg.switchAtPercent}%)`);
  }
  if (previous?.mode === "self-hosted" && sameCycle) {
    if (cfg.switchBack === "next-cycle") return make("self-hosted", `staying self-hosted until the billing cycle resets (${previous.reason})`);
    if (percentUsed >= cfg.switchBackPercent) {
      return make("self-hosted", `${percentUsed}% used; switch back below ${cfg.switchBackPercent}%`);
    }
  }
  return make("hosted", previous?.mode === "self-hosted" && !sameCycle
    ? `new billing cycle ${usage.cycle}: back to GitHub-hosted (${percentUsed}% used)`
    : `${percentUsed}% of ${cfg.includedMinutes} included minutes used`);
}

export function parseState(raw: string | undefined): State | undefined {
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw);
    if ((s.mode === "hosted" || s.mode === "self-hosted") && typeof s.cycle === "string") return s as State;
  } catch { /* corrupt state: start fresh */ }
  return undefined;
}
