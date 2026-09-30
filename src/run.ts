import { GitHubClient } from "./github.js";
import type { Config, Mode } from "./config.js";
import { fetchUsage, type Usage } from "./usage.js";
import { findRefusals, type Refusal } from "./refusals.js";
import { decide, nextState, parseState, type Decision, type State } from "./decide.js";
import { resolveOwnerType, resolveRepos } from "./repos.js";
import { applyMode, getVariable, putVariable, type RepoResult } from "./apply.js";
import { notify, notifyAlert } from "./notify.js";
import { log } from "./log.js";
import { includedMinutesFor } from "./plan.js";

export interface RunResult {
  decision: Decision;
  usage: Usage;
  refusals: Refusal[];
  repos: RepoResult[];
  reruns: number[];
  warnings: string[];
  includedMinutes: number;
}

export interface WatchdogResult {
  ok: boolean;
  message: string;
  state?: State;
  /** Minutes since Overtime last ran; undefined when it never recorded a run. */
  minutesSince?: number;
  warnings: string[];
}

const DAY_MS = 86_400_000;

/** A warning when the token expires within `warnDays` (0 disables), else undefined. */
export function tokenExpiryWarning(expiresAt: Date | undefined, now: Date, warnDays: number): { text: string; daysLeft: number; date: string } | undefined {
  if (!expiresAt || warnDays <= 0) return undefined;
  const ms = expiresAt.getTime() - now.getTime();
  if (ms > warnDays * DAY_MS) return undefined;
  const daysLeft = Math.max(0, Math.ceil(ms / DAY_MS));
  const date = expiresAt.toISOString().slice(0, 10);
  const text = ms <= 0
    ? `the GitHub token expired on ${date}; create a new one and update the secret`
    : `the GitHub token expires in ${daysLeft} day(s), on ${date} (${expiresAt.toISOString()}); rotate it and update the secret before then`;
  return { text, daysLeft, date };
}

export async function run(cfgIn: Config, now = new Date(), gh = new GitHubClient({ token: cfgIn.token, apiUrl: cfgIn.apiUrl })): Promise<RunResult> {
  // Guard: the watchdog must never decide or write. Entry points call watchdog() for it.
  if (cfgIn.watchdog) throw new Error("watchdog mode: call watchdog(), not run()");
  const warnings: string[] = [];
  const ownerType = await resolveOwnerType(gh, cfgIn.owner, cfgIn.ownerType);
  let cfg = cfgIn;
  if (cfgIn.includedMinutesAuto) {
    const { minutes, plan } = await includedMinutesFor(gh, cfgIn.owner, ownerType);
    cfg = { ...cfgIn, includedMinutes: minutes };
    log.info(`plan "${plan}": ${minutes} included minutes/month`);
  }
  const repos = await log.group("Repositories", async () => {
    const r = await resolveRepos(gh, cfg, ownerType);
    log.info(`${r.length} managed repo(s): ${r.join(", ") || "(none)"}`);
    return r;
  });
  if (!repos.length) warnings.push("no repositories matched the selection");

  const usage = await log.group("Usage", async () => {
    const u = await fetchUsage(gh, cfg.owner, ownerType, cfg.skus, now);
    log.info(`cycle ${u.cycle}: ${u.grossMinutes} min used, ${u.includedUsed} from the allowance, ${u.billedMinutes} billed ($${u.billedAmount})`);
    return u;
  });

  const refusals = cfg.detectRefusals
    ? await log.group("Refused jobs", async () => {
        const since = new Date(now.getTime() - cfg.refusalLookbackMinutes * 60_000);
        const r = await findRefusals(gh, cfg.owner, repos, since, cfg.refusalEvidence).catch((e) => { warnings.push(`refusal check failed: ${(e as Error).message}`); return []; });
        log.info(r.length ? r.map((x) => `${x.repo}#${x.runId} ${x.jobName} [${x.evidence}]: ${x.reason}`).join("\n") : "none");
        return r;
      })
    : [];

  const [previousRaw, force] = await Promise.all([
    getVariable(gh, cfg.owner, cfg.stateRepo, cfg.stateVariable).catch(() => undefined),
    getVariable(gh, cfg.owner, cfg.stateRepo, cfg.forceVariable).catch(() => undefined),
  ]);
  const previous = parseState(previousRaw);
  const decision = decide({ cfg, usage, refusals, previous, force });
  log.notice(`mode: ${decision.mode}${decision.changed ? ` (was ${previous?.mode ?? "unset"})` : ""}: ${decision.reason}`);

  const results = await log.group("Apply", async () => {
    const r = await applyMode(gh, cfg, repos, decision.mode);
    for (const x of r) log.info(`${x.repo}: ${x.variable}=${x.value} [${x.action}]${x.error ? ` ${x.error}` : ""}`);
    return r;
  });
  for (const f of results.filter((x) => x.action === "failed")) warnings.push(`${f.repo}: ${f.error}`);

  // Re-run only refusals that counted, never the same run id twice (ids persist in state), at most
  // max-reruns per invocation: a false-positive refusal must not become a re-run loop.
  const reruns: number[] = [];
  if (decision.mode === "self-hosted" && cfg.rerunRefused && decision.refusals.length && !cfg.dryRun) {
    const done = new Set(previous?.reran ?? []);
    const todo = dedupe(decision.refusals).filter((r) => !done.has(r.runId));
    let attempts = 0;
    for (const r of todo) {
      if (attempts >= cfg.maxReruns) {
        warnings.push(`re-run cap reached (max-reruns: ${cfg.maxReruns}); ${todo.length - attempts} refused run(s) left for the next run`);
        break;
      }
      attempts++;
      await gh.request("POST", `/repos/${cfg.owner}/${r.repo}/actions/runs/${r.runId}/rerun-failed-jobs`)
        .then(() => reruns.push(r.runId))
        .catch((e) => warnings.push(`rerun ${r.repo}#${r.runId} failed: ${(e as Error).message}`));
    }
  }

  // Token expiry: warn every run, notify at most once per UTC day (deduped through state).
  let tokenWarnedOn: string | undefined;
  const expiry = tokenExpiryWarning(gh.tokenExpiresAt, now, cfg.tokenExpiryWarnDays);
  if (expiry) {
    warnings.push(expiry.text);
    const today = now.toISOString().slice(0, 10);
    // Dry runs persist nothing, so they can't dedupe: they only log.
    if (cfg.notify.length && !cfg.dryRun && previous?.tokenWarnedOn !== today) {
      const errs = await notifyAlert(cfg.notify, {
        kind: "token_expiring", text: `${expiry.text}. When it expires, ${cfg.variable} stops being managed.`,
        data: { owner: cfg.owner, daysLeft: expiry.daysLeft, expiresOn: expiry.date },
      });
      warnings.push(...errs);
      if (errs.length < cfg.notify.length) tokenWarnedOn = today;
    }
  }

  // Saved every run: lastChecked is the heartbeat the watchdog reads.
  if (!cfg.dryRun) {
    const state = nextState({ previous, decision, cycle: usage.cycle, now, reran: reruns, tokenWarnedOn });
    await putVariable(gh, cfg.owner, cfg.stateRepo, cfg.stateVariable, JSON.stringify(state), previousRaw !== undefined)
      .catch((e) => warnings.push(`could not save state to ${cfg.stateRepo}/${cfg.stateVariable}: ${(e as Error).message}`));
  }

  if (decision.changed && cfg.notify.length) {
    const errs = await notify(cfg.notify, { mode: decision.mode, previous: previous?.mode, reason: decision.reason, owner: cfg.owner, repos, percentUsed: decision.percentUsed, dryRun: cfg.dryRun });
    warnings.push(...errs);
  }
  for (const w of warnings) log.warn(w);
  return { decision, usage, refusals, repos: results, reruns, warnings, includedMinutes: cfg.includedMinutes };
}

/**
 * Watchdog: is Overtime still running? Reads the state variable only; decides and writes nothing.
 * Not ok when the state or its lastChecked is missing, or lastChecked is older than stale-after-minutes.
 */
export async function watchdog(cfg: Config, now = new Date(), gh = new GitHubClient({ token: cfg.token, apiUrl: cfg.apiUrl })): Promise<WatchdogResult> {
  const warnings: string[] = [];
  const where = `${cfg.owner}/${cfg.stateRepo} variable ${cfg.stateVariable}`;
  const state = parseState(await getVariable(gh, cfg.owner, cfg.stateRepo, cfg.stateVariable));
  const last = state?.lastChecked ? new Date(state.lastChecked) : undefined;
  const minutesSince = last ? Math.max(0, Math.floor((now.getTime() - last.getTime()) / 60_000)) : undefined;

  const expiry = tokenExpiryWarning(gh.tokenExpiresAt, now, cfg.tokenExpiryWarnDays);
  if (expiry) warnings.push(expiry.text);

  let result: WatchdogResult;
  if (state && minutesSince !== undefined && minutesSince <= cfg.staleAfterMinutes) {
    result = { ok: true, message: `OK: Overtime last ran ${minutesSince} minute(s) ago (${state.lastChecked}); ${cfg.variable} is ${state.mode}`, state, minutesSince, warnings };
    log.info(result.message);
  } else {
    const message = !state
      ? `Overtime has no state in ${where}; it may never have run, and ${cfg.variable} is not being managed`
      : minutesSince === undefined
        ? `Overtime hasn't recorded when it last ran (state in ${where} has no lastChecked); ${cfg.variable} is frozen at ${state.mode}`
        : `Overtime hasn't run for ${minutesSince} minutes; ${cfg.variable} is frozen at ${state.mode}`;
    log.error(message);
    if (cfg.notify.length) {
      warnings.push(...await notifyAlert(cfg.notify, {
        kind: "stale", text: message,
        data: { owner: cfg.owner, stateRepo: cfg.stateRepo, mode: state?.mode ?? null, lastChecked: state?.lastChecked ?? null, minutesSince: minutesSince ?? null, staleAfterMinutes: cfg.staleAfterMinutes },
      }));
    }
    result = { ok: false, message, ...(state ? { state } : {}), ...(minutesSince !== undefined ? { minutesSince } : {}), warnings };
  }
  for (const w of warnings) log.warn(w);
  return result;
}

export function watchdogSummaryMarkdown(r: WatchdogResult): string {
  return [
    `## ⏱️ Overtime watchdog: ${r.ok ? "✅ running" : "❌ stale"}`,
    "",
    r.message,
    r.warnings.length ? `\n**Warnings:**\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "",
  ].join("\n");
}

function dedupe(rs: Refusal[]): Refusal[] {
  const seen = new Set<string>();
  return rs.filter((r) => { const k = `${r.repo}#${r.runId}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function summaryMarkdown(r: RunResult, cfg: Config): string {
  const included = r.includedMinutes ?? cfg.includedMinutes;
  const icon = (m: Mode) => (m === "hosted" ? "☁️ GitHub-hosted" : "🏠 self-hosted");
  const rows = r.repos.map((x) => `| ${x.repo} | \`${x.variable}\` | \`${x.value}\` | ${x.action}${x.error ? `: ${x.error}` : ""} |`).join("\n");
  return [
    `## ⏱️ Overtime: ${icon(r.decision.mode)}${cfg.dryRun ? " (dry run)" : ""}`,
    "",
    `**Why:** ${r.decision.reason}`,
    "",
    `| Cycle | Used | From allowance | Allowance | Billed |`,
    `|---|---|---|---|---|`,
    `| ${r.usage.cycle} | ${r.usage.grossMinutes} min | ${r.usage.includedUsed} min (${r.decision.percentUsed}%) | ${included} min | ${r.usage.billedMinutes} min / $${r.usage.billedAmount} |`,
    "",
    `| Repository | Variable | Value | Result |`,
    `|---|---|---|---|`,
    rows || "| (none) | | | |",
    r.refusals.length ? `\n**Refused jobs:** ${r.refusals.map((x) => `${x.repo}#${x.runId}`).join(", ")}${r.reruns.length ? ` (re-ran ${r.reruns.length})` : ""}` : "",
    r.warnings.length ? `\n**Warnings:**\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "",
  ].join("\n");
}
