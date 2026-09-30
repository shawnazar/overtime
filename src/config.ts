import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export type Mode = "hosted" | "self-hosted";
/** A runs-on value: a label string, a label array, or a {group, labels} object. */
export type RunsOn = string | string[] | { group?: string; labels?: string | string[] };

export interface NotifyTarget {
  url: string;
  format: "discord" | "slack" | "generic";
}

export interface RepoOverride {
  hosted?: RunsOn;
  selfHosted?: RunsOn;
  variable?: string;
  /** Pin this repo to a mode regardless of usage. */
  mode?: Mode;
}

export interface Config {
  token: string;
  apiUrl: string;
  owner: string;
  ownerType: "auto" | "user" | "organization";

  repos: string[];
  reposInclude: string[];
  reposExclude: string[];
  reposTopic: string;
  includeArchived: boolean;
  includeForks: boolean;

  variable: string;
  hosted: RunsOn;
  selfHosted: RunsOn;
  overrides: Record<string, RepoOverride>;

  includedMinutes: number;
  switchAtPercent: number;
  /** "next-cycle" keeps self-hosted until the 1st; "below-percent" switches back under switchBackPercent. */
  switchBack: "next-cycle" | "below-percent";
  switchBackPercent: number;
  /** SKU substrings counted as minutes (case-insensitive). Empty = all Actions minute SKUs. */
  skus: string[];
  /** Treat any billed (net) Actions usage as "free minutes are gone". */
  switchOnOverage: boolean;

  detectRefusals: boolean;
  refusalLookbackMinutes: number;
  rerunRefused: boolean;

  /** Manual override for everything: auto | hosted | self-hosted. */
  mode: "auto" | Mode;
  /** Repo/org variable that, when set to hosted/self-hosted, overrides `mode` without a redeploy. */
  forceVariable: string;

  stateRepo: string;
  stateVariable: string;

  notify: NotifyTarget[];
  dryRun: boolean;
}

export const DEFAULTS: Omit<Config, "token" | "owner" | "stateRepo"> = {
  apiUrl: "https://api.github.com",
  ownerType: "auto",
  repos: [],
  reposInclude: [],
  reposExclude: [],
  reposTopic: "",
  includeArchived: false,
  includeForks: false,
  variable: "CI_RUNS_ON",
  hosted: "ubuntu-latest",
  selfHosted: ["self-hosted"],
  overrides: {},
  includedMinutes: 2000,
  switchAtPercent: 90,
  switchBack: "next-cycle",
  switchBackPercent: 50,
  skus: [],
  switchOnOverage: true,
  detectRefusals: true,
  refusalLookbackMinutes: 120,
  rerunRefused: true,
  mode: "auto",
  forceVariable: "OVERTIME_FORCE",
  stateVariable: "OVERTIME_STATE",
  notify: [],
  dryRun: false,
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Raw string settings, keyed by kebab-case name (action inputs / OVERTIME_* env). */
export type RawSettings = Record<string, string | undefined>;

const list = (v: string | undefined): string[] =>
  (v ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

function bool(name: string, v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  if (/^(true|yes|1|on)$/i.test(v.trim())) return true;
  if (/^(false|no|0|off)$/i.test(v.trim())) return false;
  throw new ConfigError(`${name}: expected true/false, got "${v}"`);
}

function num(name: string, v: string | undefined, min: number, max: number): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name}: expected a number ${min}-${max}, got "${v}"`);
  return n;
}

/** runs-on values are JSON when they parse as JSON, else a single label. */
export function parseRunsOn(name: string, v: string | undefined): RunsOn | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const t = v.trim();
  if (/^[\[{"]/.test(t)) {
    try {
      const parsed = JSON.parse(t);
      validateRunsOn(name, parsed);
      return parsed;
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(`${name}: invalid JSON runs-on value: ${t}`);
    }
  }
  return t;
}

export function validateRunsOn(name: string, v: unknown): asserts v is RunsOn {
  const isLabels = (x: unknown) => typeof x === "string" || (Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === "string" && s));
  if (isLabels(v)) return;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ((o.group === undefined || typeof o.group === "string") && (o.labels === undefined || isLabels(o.labels)) && (o.group || o.labels)) return;
  }
  throw new ConfigError(`${name}: runs-on must be a label, a non-empty label array, or {group, labels}`);
}

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[]): T | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const t = v.trim() as T;
  if (!allowed.includes(t)) throw new ConfigError(`${name}: expected one of ${allowed.join(", ")}, got "${v}"`);
  return t;
}

/** Notify targets: "discord:https://…", "slack:https://…", or a bare URL (generic JSON). */
export function parseNotify(v: string | undefined): NotifyTarget[] {
  return list(v).map((entry) => {
    const m = entry.match(/^(discord|slack|generic):(https:\/\/.+)$/i);
    if (m) return { format: m[1]!.toLowerCase() as NotifyTarget["format"], url: m[2]! };
    if (/^https:\/\//.test(entry)) {
      const format = /discord(app)?\.com\/api\/webhooks/.test(entry) ? "discord" : /hooks\.slack\.com/.test(entry) ? "slack" : "generic";
      return { format, url: entry };
    }
    throw new ConfigError(`notify: "${entry.slice(0, 40)}…" must be an https URL, optionally prefixed with discord:, slack: or generic:`);
  });
}

interface FileConfig extends Partial<Omit<Config, "token">> {
  repos?: string[];
}

export function loadFile(path: string): FileConfig {
  if (!existsSync(path)) throw new ConfigError(`config-file: ${path} not found`);
  const doc = parseYaml(readFileSync(path, "utf8")) ?? {};
  if (typeof doc !== "object" || Array.isArray(doc)) throw new ConfigError(`config-file: ${path} must be a YAML mapping`);
  if ("token" in doc) throw new ConfigError("config-file: never put the token in the config file; pass it as a secret");
  const fc = doc as FileConfig;
  if (fc.hosted !== undefined) validateRunsOn("config-file hosted", fc.hosted);
  if (fc.selfHosted !== undefined) validateRunsOn("config-file selfHosted", fc.selfHosted);
  for (const [repo, o] of Object.entries(fc.overrides ?? {})) {
    if (o.hosted !== undefined) validateRunsOn(`overrides.${repo}.hosted`, o.hosted);
    if (o.selfHosted !== undefined) validateRunsOn(`overrides.${repo}.selfHosted`, o.selfHosted);
    if (o.mode !== undefined && o.mode !== "hosted" && o.mode !== "self-hosted") throw new ConfigError(`overrides.${repo}.mode must be hosted or self-hosted`);
  }
  return fc;
}

/**
 * Precedence: defaults < config file < explicit settings (inputs/env).
 * `context` supplies the owner/repo the action runs in, used as defaults.
 */
export function buildConfig(raw: RawSettings, context: { repository?: string } = {}): Config {
  const file = raw["config-file"] ? loadFile(raw["config-file"]) : {};
  const token = raw["token"]?.trim();
  if (!token) throw new ConfigError("token is required (a fine-grained PAT; see README for permissions)");

  const [ctxOwner, ctxRepo] = (context.repository ?? "").split("/");
  const owner = raw["owner"]?.trim() || file.owner || ctxOwner;
  if (!owner) throw new ConfigError("owner is required when not running inside GitHub Actions");

  // Repos are names under `owner`; accept "owner/name" too (also for the state repo, which
  // otherwise defaulted to an unstripped repos[0] and was addressed as /repos/owner/owner/name).
  const stripOwner = (r: string) => r.replace(new RegExp(`^${owner}/`, "i"), "");
  const repos = (list(raw["repos"]).length ? list(raw["repos"]) : file.repos ?? []).map(stripOwner);
  const cfg: Config = {
    ...DEFAULTS,
    ...stripUndefined(file),
    token,
    owner,
    stateRepo: stripOwner(raw["state-repo"]?.trim() || file.stateRepo || ctxRepo || repos[0] || ""),
    repos,
  };

  const set = <K extends keyof Config>(k: K, v: Config[K] | undefined) => {
    if (v !== undefined) cfg[k] = v;
  };
  set("apiUrl", raw["api-url"]?.trim() || undefined);
  set("ownerType", oneOf("owner-type", raw["owner-type"], ["auto", "user", "organization"] as const));
  if (list(raw["repos-include"]).length) cfg.reposInclude = list(raw["repos-include"]);
  if (list(raw["repos-exclude"]).length) cfg.reposExclude = list(raw["repos-exclude"]);
  set("reposTopic", raw["repos-topic"]?.trim() || undefined);
  set("includeArchived", bool("include-archived", raw["include-archived"]));
  set("includeForks", bool("include-forks", raw["include-forks"]));
  set("variable", raw["variable"]?.trim() || undefined);
  set("hosted", parseRunsOn("hosted-runs-on", raw["hosted-runs-on"]));
  set("selfHosted", parseRunsOn("self-hosted-runs-on", raw["self-hosted-runs-on"]));
  set("includedMinutes", num("included-minutes", raw["included-minutes"], 0, 10_000_000));
  set("switchAtPercent", num("switch-at-percent", raw["switch-at-percent"], 1, 100));
  set("switchBack", oneOf("switch-back", raw["switch-back"], ["next-cycle", "below-percent"] as const));
  set("switchBackPercent", num("switch-back-percent", raw["switch-back-percent"], 0, 100));
  if (list(raw["skus"]).length) cfg.skus = list(raw["skus"]);
  set("switchOnOverage", bool("switch-on-overage", raw["switch-on-overage"]));
  set("detectRefusals", bool("detect-refusals", raw["detect-refusals"]));
  set("refusalLookbackMinutes", num("refusal-lookback-minutes", raw["refusal-lookback-minutes"], 5, 10_080));
  set("rerunRefused", bool("rerun-refused", raw["rerun-refused"]));
  set("mode", oneOf("mode", raw["mode"], ["auto", "hosted", "self-hosted"] as const));
  set("forceVariable", raw["force-variable"]?.trim() || undefined);
  set("stateVariable", raw["state-variable"]?.trim() || undefined);
  set("dryRun", bool("dry-run", raw["dry-run"]));
  const notify = parseNotify(raw["notify"]);
  if (notify.length) cfg.notify = notify;
  else if (file.notify) cfg.notify = normalizeFileNotify(file.notify as unknown);

  validate(cfg);
  return cfg;
}

function normalizeFileNotify(v: unknown): NotifyTarget[] {
  if (!Array.isArray(v)) throw new ConfigError("config-file notify: expected a list");
  return v.flatMap((n) => {
    if (typeof n === "string") return parseNotify(n);
    if (n && typeof n === "object" && typeof (n as NotifyTarget).url === "string") {
      const t = n as Partial<NotifyTarget>;
      return parseNotify(t.format ? `${t.format}:${t.url}` : t.url!);
    }
    throw new ConfigError("config-file notify: entries must be URLs or {format, url}");
  });
}

/** Config-file values arrive typed by YAML, not by our parsers; check them the same way. */
function validateTypes(cfg: Config): void {
  const range = (k: keyof Config, min: number, max: number) => {
    const v = cfg[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new ConfigError(`${String(k)}: expected a number ${min}-${max}, got ${JSON.stringify(v)}`);
  };
  range("includedMinutes", 0, 10_000_000);
  range("switchAtPercent", 1, 100);
  range("switchBackPercent", 0, 100);
  range("refusalLookbackMinutes", 5, 10_080);
  for (const k of ["includeArchived", "includeForks", "switchOnOverage", "detectRefusals", "rerunRefused", "dryRun"] as const) {
    if (typeof cfg[k] !== "boolean") throw new ConfigError(`${k}: expected true/false, got ${JSON.stringify(cfg[k])}`);
  }
  for (const k of ["repos", "reposInclude", "reposExclude", "skus"] as const) {
    if (!Array.isArray(cfg[k]) || !cfg[k].every((x) => typeof x === "string")) throw new ConfigError(`${k}: expected a list of strings`);
  }
  const enums: [keyof Config, readonly string[]][] = [["ownerType", ["auto", "user", "organization"]], ["switchBack", ["next-cycle", "below-percent"]], ["mode", ["auto", "hosted", "self-hosted"]]];
  for (const [k, allowed] of enums) if (!allowed.includes(cfg[k] as string)) throw new ConfigError(`${String(k)}: expected one of ${allowed.join(", ")}, got ${JSON.stringify(cfg[k])}`);
  validateRunsOn("hosted", cfg.hosted);
  validateRunsOn("selfHosted", cfg.selfHosted);
}

function validate(cfg: Config): void {
  validateTypes(cfg);
  for (const v of [cfg.variable, cfg.forceVariable, cfg.stateVariable]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) || /^GITHUB_/i.test(v)) throw new ConfigError(`variable name "${v}" is not a valid Actions variable name`);
  }
  if (cfg.switchBack === "below-percent" && cfg.switchBackPercent >= cfg.switchAtPercent) {
    throw new ConfigError("switch-back-percent must be lower than switch-at-percent, or the mode would flap");
  }
  if (!cfg.repos.length && !cfg.reposInclude.length && !cfg.reposTopic) {
    throw new ConfigError("choose repositories: repos, repos-include (globs) or repos-topic");
  }
  if (!cfg.stateRepo) throw new ConfigError("state-repo is required outside GitHub Actions");
  if (!/^https:\/\//.test(cfg.apiUrl)) throw new ConfigError("api-url must be https");
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
