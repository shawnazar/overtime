export function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+)(s|m|h)?$/);
  if (!m) throw new Error(`invalid interval "${s}" (examples: 90s, 10m, 1h)`);
  const n = Number(m[1]);
  const ms = n * ({ s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m") as "s" | "m" | "h"]);
  if (ms < 60_000) throw new Error("interval must be at least 1m (GitHub API rate limits)");
  return ms;
}
