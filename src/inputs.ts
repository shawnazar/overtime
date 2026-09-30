import type { RawSettings } from "./config.js";

export const SETTINGS = [
  "token", "api-url", "owner", "owner-type", "repos", "repos-include", "repos-exclude", "repos-topic",
  "include-archived", "include-forks", "variable", "hosted-runs-on", "self-hosted-runs-on",
  "included-minutes", "switch-at-percent", "switch-back", "switch-back-percent", "skus", "switch-on-overage",
  "detect-refusals", "refusal-evidence", "refusal-lookback-minutes", "rerun-refused", "refusal-min-count",
  "refusal-min-percent", "max-reruns", "mode", "force-variable", "state-repo", "state-variable", "notify", "dry-run",
  "config-file", "token-expiry-warn-days", "watchdog", "stale-after-minutes",
] as const;

/** Action inputs arrive as INPUT_<NAME> with the name upper-cased (hyphens kept). */
export function fromActionInputs(env = process.env): RawSettings {
  return Object.fromEntries(SETTINGS.map((k) => [k, env[`INPUT_${k.toUpperCase()}`]]));
}

/** Container/CLI: OVERTIME_SWITCH_AT_PERCENT -> switch-at-percent. */
export function fromEnv(env = process.env): RawSettings {
  return Object.fromEntries(SETTINGS.map((k) => [k, env[`OVERTIME_${k.toUpperCase().replace(/-/g, "_")}`]]));
}
