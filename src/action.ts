import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildConfig } from "./config.js";
import { fromActionInputs } from "./inputs.js";
import { run, summaryMarkdown, watchdog, watchdogSummaryMarkdown } from "./run.js";
import { log } from "./log.js";

function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `EOF_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}

async function main(): Promise<void> {
  const raw = fromActionInputs();
  if (raw.token) log.mask(raw.token);
  const cfg = buildConfig(raw, { repository: process.env.GITHUB_REPOSITORY });
  if (cfg.watchdog) {
    const w = await watchdog(cfg);
    setOutput("stale", String(!w.ok));
    setOutput("reason", w.message);
    if (w.state) setOutput("mode", w.state.mode);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, watchdogSummaryMarkdown(w) + "\n");
    if (!w.ok) process.exitCode = 1;
    return;
  }
  const result = await run(cfg);

  setOutput("mode", result.decision.mode);
  setOutput("changed", String(result.decision.changed));
  setOutput("reason", result.decision.reason);
  setOutput("percent-used", String(result.decision.percentUsed));
  setOutput("minutes-used", String(result.usage.grossMinutes));
  setOutput("minutes-billed", String(result.usage.billedMinutes));
  setOutput("repos", JSON.stringify(result.repos.map((r) => r.repo)));
  setOutput("runs-on", result.repos[0]?.value ?? "");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result, cfg) + "\n");

  if (result.repos.some((r) => r.action === "failed")) process.exitCode = 1;
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
