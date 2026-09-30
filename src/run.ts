import { GitHubClient } from "./github.js";
import type { Config, Mode } from "./config.js";
import { fetchUsage, type Usage } from "./usage.js";
import { findRefusals, type Refusal } from "./refusals.js";
import { decide, parseState, type Decision, type State } from "./decide.js";
import { resolveOwnerType, resolveRepos } from "./repos.js";
import { applyMode, getVariable, putVariable, type RepoResult } from "./apply.js";
import { notify } from "./notify.js";
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

export async function run(cfgIn: Config, now = new Date(), gh = new GitHubClient({ token: cfgIn.token, apiUrl: cfgIn.apiUrl })): Promise<RunResult> {
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
        log.info(r.length ? r.map((x) => `${x.repo}#${x.runId} ${x.jobName}: ${x.reason}`).join("\n") : "none");
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

  // Persist state only when something changed, so the variable's timestamp means something.
  if (!cfg.dryRun && (decision.changed || previous?.cycle !== usage.cycle)) {
    const state: State = { mode: decision.mode, cycle: usage.cycle, since: decision.changed ? now.toISOString() : previous?.since ?? now.toISOString(), reason: decision.reason };
    await putVariable(gh, cfg.owner, cfg.stateRepo, cfg.stateVariable, JSON.stringify(state), previousRaw !== undefined)
      .catch((e) => warnings.push(`could not save state to ${cfg.stateRepo}/${cfg.stateVariable}: ${(e as Error).message}`));
  }

  const reruns: number[] = [];
  if (decision.mode === "self-hosted" && cfg.rerunRefused && refusals.length && !cfg.dryRun) {
    for (const r of dedupe(refusals)) {
      await gh.request("POST", `/repos/${cfg.owner}/${r.repo}/actions/runs/${r.runId}/rerun-failed-jobs`)
        .then(() => reruns.push(r.runId))
        .catch((e) => warnings.push(`rerun ${r.repo}#${r.runId} failed: ${(e as Error).message}`));
    }
  }

  if (decision.changed && cfg.notify.length) {
    const errs = await notify(cfg.notify, { mode: decision.mode, previous: previous?.mode, reason: decision.reason, owner: cfg.owner, repos, percentUsed: decision.percentUsed, dryRun: cfg.dryRun });
    warnings.push(...errs);
  }
  for (const w of warnings) log.warn(w);
  return { decision, usage, refusals, repos: results, reruns, warnings, includedMinutes: cfg.includedMinutes };
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
