import type { GitHubClient } from "./github.js";
import type { Config } from "./config.js";

interface Repo { name: string; archived: boolean; fork: boolean; topics?: string[]; owner: { login: string } }

/** Minimal glob: `*` any run of characters, `?` one character. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

export function filterRepos(all: Repo[], cfg: Pick<Config, "reposInclude" | "reposExclude" | "reposTopic" | "includeArchived" | "includeForks">): string[] {
  const inc = cfg.reposInclude.map(globToRegExp);
  const exc = cfg.reposExclude.map(globToRegExp);
  return all
    .filter((r) => cfg.includeArchived || !r.archived)
    .filter((r) => cfg.includeForks || !r.fork)
    .filter((r) => !cfg.reposTopic || (r.topics ?? []).includes(cfg.reposTopic))
    .filter((r) => !inc.length || inc.some((re) => re.test(r.name)))
    .filter((r) => !exc.some((re) => re.test(r.name)))
    .map((r) => r.name)
    .sort();
}

export async function resolveOwnerType(gh: GitHubClient, owner: string, configured: Config["ownerType"]): Promise<"user" | "organization"> {
  if (configured !== "auto") return configured;
  const u = await gh.request<{ type: string }>("GET", `/users/${owner}`);
  return u.type === "Organization" ? "organization" : "user";
}

export async function resolveRepos(gh: GitHubClient, cfg: Config, ownerType: "user" | "organization"): Promise<string[]> {
  const exc = cfg.reposExclude.map(globToRegExp);
  const explicit = cfg.repos.filter((r) => !exc.some((re) => re.test(r)));
  if (!cfg.reposInclude.length && !cfg.reposTopic) return [...new Set(explicit)].sort();
  // /user/repos includes private repos for a personal account; /users/{u}/repos would not.
  const all = ownerType === "organization"
    ? await gh.paginate<Repo>(`/orgs/${cfg.owner}/repos`, { type: "all" })
    : (await gh.paginate<Repo>(`/user/repos`, { affiliation: "owner" })).filter((r) => r.owner.login.toLowerCase() === cfg.owner.toLowerCase());
  return [...new Set([...explicit, ...filterRepos(all, cfg)])].sort();
}
