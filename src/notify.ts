import type { NotifyTarget } from "./config.js";

export interface Event {
  mode: "hosted" | "self-hosted";
  previous?: "hosted" | "self-hosted";
  reason: string;
  owner: string;
  repos: string[];
  percentUsed: number;
  dryRun: boolean;
}

export function render(target: NotifyTarget, e: Event): unknown {
  const who = e.mode === "self-hosted" ? "Your runners are on the clock" : "GitHub-hosted runners are back";
  const text = `⏱️ **Overtime** ${e.dryRun ? "(dry run) " : ""}— ${who}: \`${e.previous ?? "?"}\` → \`${e.mode}\` for ${e.repos.length} repo(s) under ${e.owner}.\n${e.reason}`;
  if (target.format === "discord") return { content: text.slice(0, 1900), allowed_mentions: { parse: [] } };
  if (target.format === "slack") return { text: text.replace(/\*\*/g, "*") };
  return { event: "overtime.mode_changed", ...e };
}

export async function notify(targets: NotifyTarget[], e: Event, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const errors: string[] = [];
  for (const t of targets) {
    try {
      const res = await fetchImpl(t.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(render(t, e)) });
      if (!res.ok) errors.push(`${t.format} webhook -> ${res.status}`);
    } catch (err) {
      errors.push(`${t.format} webhook -> ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors;
}
