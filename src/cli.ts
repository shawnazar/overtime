import { buildConfig } from "./config.js";
import { fromEnv } from "./inputs.js";
import { run, summaryMarkdown, watchdog, watchdogSummaryMarkdown } from "./run.js";
import { log } from "./log.js";
import { parseDuration } from "./duration.js";

const HELP = `overtime: route GitHub Actions to self-hosted runners when included minutes run out

Usage: overtime [--once] [--interval 10m] [--config overtime.yml] [--dry-run]
       overtime --watchdog [--config overtime.yml]

--watchdog checks that Overtime's state was refreshed within stale-after-minutes (default 60)
and exits 1 (after notifying) when it wasn't. It runs once, reads only the state variable
and writes nothing: run it from cron somewhere other than where Overtime runs.

Settings come from OVERTIME_* environment variables (OVERTIME_TOKEN, OVERTIME_OWNER,
OVERTIME_REPOS, OVERTIME_SWITCH_AT_PERCENT, ...) and/or a YAML config file.
See https://github.com/shawnazar/overtime#configuration`;


async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const raw = fromEnv();
  if (arg("--config")) raw["config-file"] = arg("--config");
  if (argv.includes("--dry-run")) raw["dry-run"] = "true";
  if (argv.includes("--watchdog")) raw["watchdog"] = "true";
  const cfg = buildConfig(raw, { repository: process.env.GITHUB_REPOSITORY });
  if (cfg.watchdog) {
    // One check per invocation (cron-style); a loop would re-notify every interval while stale.
    const w = await watchdog(cfg);
    console.log(watchdogSummaryMarkdown(w));
    if (!w.ok) process.exitCode = 1;
    return;
  }
  const once = argv.includes("--once") || process.env.OVERTIME_ONCE === "true";
  const interval = parseDuration(arg("--interval") ?? process.env.OVERTIME_INTERVAL ?? "10m");

  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stopping = true; log.info(`${sig}: stopping after this cycle`); });

  do {
    try {
      const r = await run(cfg);
      if (once) console.log(summaryMarkdown(r, cfg));
    } catch (e) {
      log.error(e instanceof Error ? e.message : String(e));
      if (once) process.exitCode = 1;
    }
    if (once || stopping) break;
    await new Promise((res) => { const t = setTimeout(res, interval); process.once("SIGTERM", () => { clearTimeout(t); res(undefined); }); });
  } while (!stopping);
}

main(process.argv.slice(2)).catch((e) => { log.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
