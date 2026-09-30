import type { GitHubClient } from "./github.js";
import { GitHubError } from "./github.js";
import type { Config, Mode, RunsOn } from "./config.js";

export interface RepoResult {
  repo: string;
  variable: string;
  value: string;
  previous?: string;
  action: "unchanged" | "updated" | "created" | "would-update" | "would-create" | "failed";
  error?: string;
}

/** What `runs-on: ${{ fromJSON(vars.X) }}` needs: always JSON (a label becomes "\"label\""). */
export function encodeRunsOn(v: RunsOn): string {
  return JSON.stringify(v);
}

export function desiredFor(cfg: Pick<Config, "hosted" | "selfHosted" | "variable" | "overrides">, repo: string, mode: Mode): { variable: string; value: string; mode: Mode } {
  const o = cfg.overrides[repo] ?? {};
  const effective = o.mode ?? mode;
  const runsOn = effective === "hosted" ? (o.hosted ?? cfg.hosted) : (o.selfHosted ?? cfg.selfHosted);
  return { variable: o.variable ?? cfg.variable, value: encodeRunsOn(runsOn), mode: effective };
}

export async function getVariable(gh: GitHubClient, owner: string, repo: string, name: string): Promise<string | undefined> {
  try {
    return (await gh.request<{ value: string }>("GET", `/repos/${owner}/${repo}/actions/variables/${name}`)).value;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return undefined;
    throw e;
  }
}

export async function putVariable(gh: GitHubClient, owner: string, repo: string, name: string, value: string, exists: boolean): Promise<void> {
  if (exists) await gh.request("PATCH", `/repos/${owner}/${repo}/actions/variables/${name}`, { body: { name, value } });
  else await gh.request("POST", `/repos/${owner}/${repo}/actions/variables`, { body: { name, value } });
}

export async function applyMode(gh: GitHubClient, cfg: Config, repos: string[], mode: Mode): Promise<RepoResult[]> {
  const results: RepoResult[] = [];
  for (const repo of repos) {
    const { variable, value } = desiredFor(cfg, repo, mode);
    try {
      const previous = await getVariable(gh, cfg.owner, repo, variable);
      if (previous === value) { results.push({ repo, variable, value, previous, action: "unchanged" }); continue; }
      if (cfg.dryRun) { results.push({ repo, variable, value, previous, action: previous === undefined ? "would-create" : "would-update" }); continue; }
      await putVariable(gh, cfg.owner, repo, variable, value, previous !== undefined);
      results.push({ repo, variable, value, previous, action: previous === undefined ? "created" : "updated" });
    } catch (e) {
      results.push({ repo, variable, value, action: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
