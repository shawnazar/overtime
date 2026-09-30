import { describe, it, expect } from "vitest";
import { encodeRunsOn, desiredFor, applyMode, getVariable } from "../src/apply.js";
import { GitHubError } from "../src/github.js";
import { client, config, type Call } from "./helpers.js";

describe("encodeRunsOn", () => {
  it("always produces JSON for fromJSON()", () => {
    expect(encodeRunsOn("ubuntu-latest")).toBe('"ubuntu-latest"');
    expect(encodeRunsOn(["self-hosted", "linux"])).toBe('["self-hosted","linux"]');
    expect(encodeRunsOn({ group: "homelab", labels: ["x"] })).toBe('{"group":"homelab","labels":["x"]}');
  });
});

describe("desiredFor", () => {
  const cfg = config({
    hosted: "ubuntu-latest",
    selfHosted: ["self-hosted"],
    overrides: {
      mac: { hosted: "macos-latest", selfHosted: ["self-hosted", "macOS"], variable: "MAC_RUNS_ON" },
      pinned: { mode: "hosted" },
      pinnedSelf: { mode: "self-hosted", selfHosted: { group: "big" } },
    },
  });

  it("uses global runs-on values without an override", () => {
    expect(desiredFor(cfg, "plain", "hosted")).toEqual({ variable: "CI_RUNS_ON", value: '"ubuntu-latest"', mode: "hosted" });
    expect(desiredFor(cfg, "plain", "self-hosted")).toEqual({ variable: "CI_RUNS_ON", value: '["self-hosted"]', mode: "self-hosted" });
  });
  it("applies per-repo runs-on and variable overrides", () => {
    expect(desiredFor(cfg, "mac", "hosted")).toEqual({ variable: "MAC_RUNS_ON", value: '"macos-latest"', mode: "hosted" });
    expect(desiredFor(cfg, "mac", "self-hosted")).toEqual({ variable: "MAC_RUNS_ON", value: '["self-hosted","macOS"]', mode: "self-hosted" });
  });
  it("honours a pinned mode regardless of the decided mode", () => {
    expect(desiredFor(cfg, "pinned", "self-hosted")).toEqual({ variable: "CI_RUNS_ON", value: '"ubuntu-latest"', mode: "hosted" });
    expect(desiredFor(cfg, "pinnedSelf", "hosted")).toEqual({ variable: "CI_RUNS_ON", value: '{"group":"big"}', mode: "self-hosted" });
  });
});

describe("getVariable", () => {
  it("returns undefined on 404 and rethrows other errors", async () => {
    expect(await getVariable(client(() => undefined).gh, "me", "a", "X")).toBeUndefined();
    await expect(getVariable(client(() => ({ status: 403, body: "nope" })).gh, "me", "a", "X")).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("applyMode", () => {
  /** repo -> current value of CI_RUNS_ON (absent = not set). */
  function github(vars: Record<string, string>, fail: Record<string, number> = {}) {
    return client((c: Call) => {
      const m = c.path.match(/^\/repos\/me\/([^/]+)\/actions\/variables(?:\/(\w+))?$/);
      if (!m) return undefined;
      const [, repo, name] = m;
      if (fail[repo!]) return { status: fail[repo!], body: { message: "boom" } };
      if (c.method === "GET") return repo! in vars ? { body: { name, value: vars[repo!] } } : undefined;
      return { status: c.method === "POST" ? 201 : 204 };
    }, 0);
  }
  const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET").map((c) => ({ method: c.method, path: c.path, body: c.body }));

  it("reports unchanged, updated and created, and writes only what differs", async () => {
    const { gh, calls } = github({ same: '["self-hosted"]', stale: '"ubuntu-latest"' });
    const res = await applyMode(gh, config(), ["same", "stale", "fresh"], "self-hosted");
    expect(res).toEqual([
      { repo: "same", variable: "CI_RUNS_ON", value: '["self-hosted"]', previous: '["self-hosted"]', action: "unchanged" },
      { repo: "stale", variable: "CI_RUNS_ON", value: '["self-hosted"]', previous: '"ubuntu-latest"', action: "updated" },
      { repo: "fresh", variable: "CI_RUNS_ON", value: '["self-hosted"]', previous: undefined, action: "created" },
    ]);
    expect(writes(calls)).toEqual([
      { method: "PATCH", path: "/repos/me/stale/actions/variables/CI_RUNS_ON", body: { name: "CI_RUNS_ON", value: '["self-hosted"]' } },
      { method: "POST", path: "/repos/me/fresh/actions/variables", body: { name: "CI_RUNS_ON", value: '["self-hosted"]' } },
    ]);
  });

  it("dry run reports would-update/would-create and writes nothing", async () => {
    const { gh, calls } = github({ same: '"ubuntu-latest"', stale: '["self-hosted"]' });
    const res = await applyMode(gh, config({ dryRun: true }), ["same", "stale", "fresh"], "hosted");
    expect(res.map((r) => r.action)).toEqual(["unchanged", "would-update", "would-create"]);
    expect(writes(calls)).toEqual([]);
  });

  it("records failures per repo and carries on", async () => {
    const { gh } = github({ ok: '"x"' }, { broken: 500 });
    const res = await applyMode(gh, config(), ["broken", "ok"], "hosted");
    expect(res[0]).toMatchObject({ repo: "broken", action: "failed" });
    expect(res[0]!.error).toMatch(/-> 500/);
    expect(res[1]).toMatchObject({ repo: "ok", action: "updated" });
  });

  it("records a failed write", async () => {
    const { gh } = client((c) => (c.method === "GET" ? undefined : { status: 403, body: { message: "Resource not accessible" } }), 0);
    const [r] = await applyMode(gh, config(), ["a"], "hosted");
    expect(r).toMatchObject({ action: "failed" });
    expect(r!.error).toContain("POST /repos/me/a/actions/variables -> 403");
  });
});
