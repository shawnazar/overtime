import { describe, it, expect } from "vitest";
import { globToRegExp, filterRepos, resolveRepos, resolveOwnerType } from "../src/repos.js";
import { client, config } from "./helpers.js";

const repo = (name: string, over: { archived?: boolean; fork?: boolean; topics?: string[]; owner?: string } = {}) => ({
  name, archived: over.archived ?? false, fork: over.fork ?? false, topics: over.topics, owner: { login: over.owner ?? "me" },
});
const noFilter = { reposInclude: [], reposExclude: [], reposTopic: "", includeArchived: false, includeForks: false };

describe("globToRegExp", () => {
  it("supports * and ?, anchored and case-insensitive", () => {
    const re = globToRegExp("web-*");
    expect(re.test("web-app")).toBe(true);
    expect(re.test("WEB-")).toBe(true);
    expect(re.test("my-web-app")).toBe(false);
    expect(globToRegExp("api-?").test("api-1")).toBe(true);
    expect(globToRegExp("api-?").test("api-12")).toBe(false);
  });
  it("escapes regex metacharacters", () => {
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("x+(y)").test("x+(y)")).toBe(true);
    expect(globToRegExp("[a]").test("[a]")).toBe(true);
  });
});

describe("filterRepos", () => {
  const all = [
    repo("zeta"), repo("alpha", { topics: ["ci"] }), repo("old", { archived: true, topics: ["ci"] }),
    repo("forked", { fork: true, topics: ["ci"] }), repo("web-app"), repo("web-legacy"),
  ];

  it("excludes archived and forks by default, sorted", () => {
    expect(filterRepos(all, noFilter)).toEqual(["alpha", "web-app", "web-legacy", "zeta"]);
  });
  it("includes archived and forks when asked", () => {
    expect(filterRepos(all, { ...noFilter, includeArchived: true, includeForks: true })).toHaveLength(6);
  });
  it("filters by topic", () => {
    expect(filterRepos(all, { ...noFilter, reposTopic: "ci" })).toEqual(["alpha"]);
    expect(filterRepos(all, { ...noFilter, reposTopic: "ci", includeArchived: true, includeForks: true })).toEqual(["alpha", "forked", "old"]);
  });
  it("applies include then exclude globs", () => {
    expect(filterRepos(all, { ...noFilter, reposInclude: ["web-*"], reposExclude: ["*-legacy"] })).toEqual(["web-app"]);
  });
});

describe("resolveOwnerType", () => {
  it("returns the configured type without calling the API", async () => {
    const { gh, calls } = client(() => undefined);
    expect(await resolveOwnerType(gh, "me", "organization")).toBe("organization");
    expect(calls).toHaveLength(0);
  });
  it("detects users and organizations", async () => {
    const { gh } = client((c) => ({ body: { type: c.path === "/users/acme" ? "Organization" : "User" } }));
    expect(await resolveOwnerType(gh, "acme", "auto")).toBe("organization");
    expect(await resolveOwnerType(gh, "me", "auto")).toBe("user");
  });
});

describe("resolveRepos", () => {
  it("uses only explicit repos (minus excludes) without discovery", async () => {
    const { gh, calls } = client(() => undefined);
    const cfg = config({ repos: ["b", "a", "b", "skip-me"], reposExclude: ["skip-*"] });
    expect(await resolveRepos(gh, cfg, "user")).toEqual(["a", "b"]);
    expect(calls).toHaveLength(0);
  });

  it("discovers a user's repos via /user/repos, filtered to the owner, merged with explicit", async () => {
    const { gh, calls } = client((c) =>
      c.path === "/user/repos"
        ? { body: [repo("tool", { topics: ["ci"] }), repo("theirs", { owner: "someone-else", topics: ["ci"] }), repo("untagged")] }
        : undefined);
    const cfg = config({ owner: "Me", repos: ["explicit"], reposTopic: "ci" });
    expect(await resolveRepos(gh, cfg, "user")).toEqual(["explicit", "tool"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("affiliation")).toBe("owner");
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100");
  });

  it("discovers an organization's repos via /orgs/{org}/repos", async () => {
    const { gh, calls } = client((c) =>
      c.path === "/orgs/acme/repos" ? { body: [repo("svc-a", { owner: "acme" }), repo("svc-b", { owner: "acme" }), repo("docs", { owner: "acme" })] } : undefined);
    const cfg = config({ owner: "acme", repos: [], reposInclude: ["svc-*"] });
    expect(await resolveRepos(gh, cfg, "organization")).toEqual(["svc-a", "svc-b"]);
    expect(calls[0]!.path).toBe("/orgs/acme/repos");
    expect(calls[0]!.url.searchParams.get("type")).toBe("all");
  });
});
