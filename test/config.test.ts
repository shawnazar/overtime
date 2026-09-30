import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, parseRunsOn, validateRunsOn, parseNotify, loadFile, ConfigError, DEFAULTS, type RawSettings } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "overtime-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function yamlFile(content: string): string {
  const p = join(dir, `config-${n++}.yml`);
  writeFileSync(p, content);
  return p;
}

const base: RawSettings = { token: "tok", owner: "me", repos: "a" };
const build = (raw: RawSettings, ctx = {}) => buildConfig({ ...base, ...raw }, ctx);

describe("buildConfig: basics and precedence", () => {
  it("applies defaults", () => {
    const c = build({});
    expect(c).toMatchObject({ ...DEFAULTS, token: "tok", owner: "me", repos: ["a"], stateRepo: "a" });
  });

  it("config file overrides defaults; raw settings override the file", () => {
    const file = yamlFile([
      "owner: file-owner",
      "includedMinutes: 3000",
      "switchAtPercent: 80",
      "variable: FILE_VAR",
      "hosted: [ubuntu-24.04]",
      "selfHosted: { group: homelab, labels: [linux] }",
      "repos: [x, y]",
      "stateRepo: state",
      "overrides:",
      "  x: { mode: self-hosted, variable: X_VAR }",
      "notify:",
      "  - { format: slack, url: 'https://hooks.slack.com/services/T/B/C' }",
    ].join("\n"));
    const fromFile = buildConfig({ token: "tok", "config-file": file });
    expect(fromFile).toMatchObject({
      owner: "file-owner", includedMinutes: 3000, switchAtPercent: 80, variable: "FILE_VAR",
      hosted: ["ubuntu-24.04"], selfHosted: { group: "homelab", labels: ["linux"] },
      repos: ["x", "y"], stateRepo: "state", overrides: { x: { mode: "self-hosted", variable: "X_VAR" } },
      notify: [{ format: "slack", url: "https://hooks.slack.com/services/T/B/C" }],
      switchBack: "next-cycle", // untouched default
    });

    const overridden = buildConfig({
      token: "tok", "config-file": file, owner: "raw-owner", "included-minutes": "500", variable: "RAW_VAR",
      "hosted-runs-on": "macos-latest", repos: "z", "state-repo": "raw-state", notify: "https://example.com/hook",
    });
    expect(overridden).toMatchObject({
      owner: "raw-owner", includedMinutes: 500, switchAtPercent: 80, variable: "RAW_VAR", hosted: "macos-latest",
      repos: ["z"], stateRepo: "raw-state", notify: [{ format: "generic", url: "https://example.com/hook" }],
    });
  });

  it("requires a token", () => {
    expect(() => buildConfig({ owner: "me", repos: "a" })).toThrow(/token is required/);
    expect(() => buildConfig({ token: "  ", owner: "me", repos: "a" })).toThrow(ConfigError);
  });

  it("rejects a token in the config file", () => {
    const file = yamlFile("token: ghp_oops\nrepos: [a]\n");
    expect(() => build({ "config-file": file })).toThrow(/never put the token in the config file/);
  });

  it("rejects a missing or non-mapping config file", () => {
    expect(() => build({ "config-file": join(dir, "missing.yml") })).toThrow(/not found/);
    expect(() => build({ "config-file": yamlFile("- a\n- b\n") })).toThrow(/must be a YAML mapping/);
  });

  it("validates runs-on and override modes in the config file", () => {
    expect(() => loadFile(yamlFile("hosted: []\n"))).toThrow(/config-file hosted/);
    expect(() => loadFile(yamlFile("overrides:\n  x: { selfHosted: 5 }\n"))).toThrow(/overrides\.x\.selfHosted/);
    expect(() => loadFile(yamlFile("overrides:\n  x: { mode: auto }\n"))).toThrow(/overrides\.x\.mode/);
    expect(loadFile(yamlFile(""))).toEqual({});
  });

  it("takes owner and state repo from the Actions context", () => {
    const c = buildConfig({ token: "tok", repos: "a,b" }, { repository: "ctx-owner/ctx-repo" });
    expect(c.owner).toBe("ctx-owner");
    expect(c.stateRepo).toBe("ctx-repo");
  });

  it("requires an owner outside Actions", () => {
    expect(() => buildConfig({ token: "tok", repos: "a" })).toThrow(/owner is required/);
  });

  it("strips an 'owner/' prefix from repos, case-insensitively", () => {
    expect(build({ repos: "me/a, ME/b, other/c, d" }).repos).toEqual(["a", "b", "other/c", "d"]);
  });

  it("defaults the state repo to the first repo without its owner prefix", () => {
    expect(build({ repos: "me/a,me/b" }).stateRepo).toBe("a");
    expect(build({ "state-repo": "Me/state" }).stateRepo).toBe("state");
  });

  it("parses lists separated by commas and newlines", () => {
    const c = build({ repos: "a, b\nc,,\n d ", "repos-include": "web-*\napi-?", "repos-exclude": "*-old", skus: "linux, macos" });
    expect(c.repos).toEqual(["a", "b", "c", "d"]);
    expect(c.reposInclude).toEqual(["web-*", "api-?"]);
    expect(c.reposExclude).toEqual(["*-old"]);
    expect(c.skus).toEqual(["linux", "macos"]);
  });

  it("parses booleans in several spellings and rejects others", () => {
    expect(build({ "dry-run": "YES", "include-forks": "1", "include-archived": "on", "rerun-refused": "off", "detect-refusals": "no", "switch-on-overage": "False" }))
      .toMatchObject({ dryRun: true, includeForks: true, includeArchived: true, rerunRefused: false, detectRefusals: false, switchOnOverage: false });
    expect(() => build({ "dry-run": "sure" })).toThrow(/dry-run: expected true\/false, got "sure"/);
  });

  it("validates numbers and their ranges", () => {
    expect(build({ "switch-at-percent": "75.5" }).switchAtPercent).toBe(75.5);
    expect(() => build({ "included-minutes": "lots" })).toThrow(/included-minutes: expected a number/);
    expect(() => build({ "switch-at-percent": "0" })).toThrow(/switch-at-percent: expected a number 1-100/);
    expect(() => build({ "switch-at-percent": "101" })).toThrow(ConfigError);
    expect(() => build({ "refusal-lookback-minutes": "4" })).toThrow(/refusal-lookback-minutes/);
  });

  it("validates enumerations", () => {
    expect(build({ mode: "self-hosted", "owner-type": "organization" })).toMatchObject({ mode: "self-hosted", ownerType: "organization" });
    expect(() => build({ mode: "turbo" })).toThrow(/mode: expected one of auto, hosted, self-hosted/);
    expect(() => build({ "switch-back": "never" })).toThrow(/switch-back/);
  });

  it("rejects switch-back-percent >= switch-at-percent with below-percent", () => {
    expect(() => build({ "switch-back": "below-percent", "switch-back-percent": "90", "switch-at-percent": "90" })).toThrow(/would flap/);
    expect(build({ "switch-back": "below-percent", "switch-back-percent": "89", "switch-at-percent": "90" }).switchBackPercent).toBe(89);
    // Irrelevant for next-cycle.
    expect(build({ "switch-back-percent": "95" }).switchBackPercent).toBe(95);
  });

  it("rejects invalid variable names, including the GITHUB_ prefix", () => {
    expect(() => build({ variable: "1BAD" })).toThrow(/not a valid Actions variable name/);
    expect(() => build({ variable: "has-dash" })).toThrow(/has-dash/);
    expect(() => build({ "force-variable": "GITHUB_FORCE" })).toThrow(/GITHUB_FORCE/);
    expect(() => build({ "state-variable": "github_state" })).toThrow(/github_state/);
    expect(build({ variable: "_ok_1" }).variable).toBe("_ok_1");
  });

  it("requires some repository selection", () => {
    expect(() => buildConfig({ token: "tok", owner: "me", "state-repo": "s" })).toThrow(/choose repositories/);
    expect(buildConfig({ token: "tok", owner: "me", "state-repo": "s", "repos-topic": "ci" }).reposTopic).toBe("ci");
    expect(buildConfig({ token: "tok", owner: "me", "state-repo": "s", "repos-include": "*" }).reposInclude).toEqual(["*"]);
  });

  it("requires a state repo when discovery is used outside Actions", () => {
    expect(() => buildConfig({ token: "tok", owner: "me", "repos-topic": "ci" })).toThrow(/state-repo is required/);
  });

  it("requires an https api-url", () => {
    expect(() => build({ "api-url": "http://ghe.local/api/v3" })).toThrow(/api-url must be https/);
    expect(build({ "api-url": "https://ghe.local/api/v3" }).apiUrl).toBe("https://ghe.local/api/v3");
  });
});

describe("parseRunsOn / validateRunsOn", () => {
  it("returns undefined for empty input", () => {
    expect(parseRunsOn("x", undefined)).toBeUndefined();
    expect(parseRunsOn("x", "  ")).toBeUndefined();
  });
  it("treats plain text as a single label", () => {
    expect(parseRunsOn("x", " ubuntu-latest ")).toBe("ubuntu-latest");
  });
  it("parses JSON arrays, strings and group objects", () => {
    expect(parseRunsOn("x", '["self-hosted","linux"]')).toEqual(["self-hosted", "linux"]);
    expect(parseRunsOn("x", '"quoted"')).toBe("quoted");
    expect(parseRunsOn("x", '{"group":"homelab","labels":"linux"}')).toEqual({ group: "homelab", labels: "linux" });
    expect(parseRunsOn("x", '{"labels":["a"]}')).toEqual({ labels: ["a"] });
  });
  it("rejects invalid JSON and invalid shapes", () => {
    expect(() => parseRunsOn("hosted-runs-on", "[oops")).toThrow(/hosted-runs-on: invalid JSON runs-on value/);
    expect(() => parseRunsOn("x", "[]")).toThrow(/runs-on must be/);
    expect(() => parseRunsOn("x", '["a", 1]')).toThrow(/runs-on must be/);
    expect(() => parseRunsOn("x", '["a", ""]')).toThrow(/runs-on must be/);
    expect(() => parseRunsOn("x", "{}")).toThrow(/runs-on must be/);
    expect(() => parseRunsOn("x", '{"group": 5}')).toThrow(/runs-on must be/);
    expect(() => parseRunsOn("x", '{"group":"g","labels":[]}')).toThrow(/runs-on must be/);
  });
  it("validateRunsOn accepts the valid shapes", () => {
    for (const v of ["a", ["a", "b"], { group: "g" }, { labels: "l" }, { group: "g", labels: ["l"] }]) {
      expect(() => validateRunsOn("x", v)).not.toThrow();
    }
    for (const v of [null, 5, [], {}, { group: "" }]) expect(() => validateRunsOn("x", v)).toThrow(ConfigError);
  });
});

describe("parseNotify", () => {
  it("parses prefixed entries", () => {
    expect(parseNotify("Discord:https://a.example/x, slack:https://b.example/y\ngeneric:https://c.example/z")).toEqual([
      { format: "discord", url: "https://a.example/x" },
      { format: "slack", url: "https://b.example/y" },
      { format: "generic", url: "https://c.example/z" },
    ]);
  });
  it("auto-detects bare Discord and Slack webhook URLs", () => {
    expect(parseNotify("https://discord.com/api/webhooks/1/abc")).toEqual([{ format: "discord", url: "https://discord.com/api/webhooks/1/abc" }]);
    expect(parseNotify("https://discordapp.com/api/webhooks/1/abc")[0]!.format).toBe("discord");
    expect(parseNotify("https://hooks.slack.com/services/T/B/C")[0]!.format).toBe("slack");
  });
  it("treats other https URLs as generic", () => {
    expect(parseNotify("https://example.com/hook")).toEqual([{ format: "generic", url: "https://example.com/hook" }]);
  });
  it("returns [] for nothing", () => {
    expect(parseNotify(undefined)).toEqual([]);
    expect(parseNotify("")).toEqual([]);
  });
  it("rejects non-https URLs", () => {
    expect(() => parseNotify("http://example.com/hook")).toThrow(/must be an https URL/);
    expect(() => parseNotify("discord:http://example.com/hook")).toThrow(ConfigError);
    expect(() => parseNotify("not a url")).toThrow(ConfigError);
  });
});

describe("config file hardening", () => {
  it("accepts plain URL strings for notify in YAML", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildConfig } = await import("../src/config.js");
    const f = join(mkdtempSync(join(tmpdir(), "ot-")), "c.yml");
    writeFileSync(f, "notify:\n  - https://discord.com/api/webhooks/1/abc\n  - slack:https://hooks.slack.com/x\n  - {format: generic, url: 'https://example.com/h'}\n");
    const cfg = buildConfig({ token: "t", owner: "me", repos: "a", "config-file": f });
    expect(cfg.notify.map((n) => n.format)).toEqual(["discord", "slack", "generic"]);
  });

  it("validates types coming from the YAML file", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildConfig } = await import("../src/config.js");
    const dir = mkdtempSync(join(tmpdir(), "ot-"));
    const bad: [string, RegExp][] = [
      ["switchAtPercent: 150\n", /switchAtPercent/],
      ["includedMinutes: lots\n", /includedMinutes/],
      ["dryRun: maybe\n", /dryRun/],
      ["mode: sometimes\n", /mode/],
      ["reposExclude: nope\n", /reposExclude/],
    ];
    for (const [yaml, re] of bad) {
      const f = join(dir, `${Math.random()}.yml`);
      writeFileSync(f, yaml);
      expect(() => buildConfig({ token: "t", owner: "me", repos: "a", "config-file": f })).toThrow(re);
    }
  });
});

describe("detectFormat (hostname, not substring)", () => {
  it("recognises real Discord and Slack webhook hosts", async () => {
    const { detectFormat } = await import("../src/config.js");
    expect(detectFormat("https://discord.com/api/webhooks/1/abc")).toBe("discord");
    expect(detectFormat("https://canary.discord.com/api/webhooks/1/abc")).toBe("discord");
    expect(detectFormat("https://discordapp.com/api/webhooks/1/abc")).toBe("discord");
    expect(detectFormat("https://hooks.slack.com/services/x")).toBe("slack");
  });

  it("does not trust look-alike URLs", async () => {
    const { detectFormat } = await import("../src/config.js");
    expect(detectFormat("https://evil.example/?x=discord.com/api/webhooks/1/a")).toBe("generic");
    expect(detectFormat("https://discord.com.evil.example/api/webhooks/1/a")).toBe("generic");
    expect(detectFormat("https://evil.example/hooks.slack.com")).toBe("generic");
    expect(detectFormat("https://discord.com/not-webhooks")).toBe("generic");
  });
});

describe("buildConfig: refusal, re-run, expiry and watchdog settings (#9, #10)", () => {
  it("has the documented defaults", () => {
    expect(build({})).toMatchObject({ refusalMinCount: 2, refusalMinPercent: 80, maxReruns: 10, tokenExpiryWarnDays: 14, watchdog: false, staleAfterMinutes: 60 });
  });

  it("parses the settings from inputs/env", () => {
    expect(build({ "refusal-min-count": "3", "refusal-min-percent": "0", "max-reruns": "0", "token-expiry-warn-days": "30", watchdog: "true", "stale-after-minutes": "90" }))
      .toMatchObject({ refusalMinCount: 3, refusalMinPercent: 0, maxReruns: 0, tokenExpiryWarnDays: 30, watchdog: true, staleAfterMinutes: 90 });
    expect(build({ "refusal-min-percent": "72.5" }).refusalMinPercent).toBe(72.5);
  });

  it("validates ranges and whole numbers", () => {
    expect(() => build({ "refusal-min-count": "0" })).toThrow(/refusal-min-count: expected a number 1-100/);
    expect(() => build({ "refusal-min-count": "1.5" })).toThrow(/refusal-min-count: expected a whole number/);
    expect(() => build({ "refusal-min-percent": "101" })).toThrow(/refusal-min-percent/);
    expect(() => build({ "max-reruns": "-1" })).toThrow(/max-reruns/);
    expect(() => build({ "token-expiry-warn-days": "366" })).toThrow(/token-expiry-warn-days/);
    expect(() => build({ "stale-after-minutes": "4" })).toThrow(/stale-after-minutes/);
    expect(() => build({ watchdog: "sometimes" })).toThrow(/watchdog: expected true\/false/);
  });

  it("reads them from the config file and type-checks them", () => {
    const f = yamlFile("refusalMinCount: 4\nrefusalMinPercent: 50\nmaxReruns: 3\ntokenExpiryWarnDays: 7\nwatchdog: true\nstaleAfterMinutes: 45\n");
    expect(buildConfig({ ...base, "config-file": f })).toMatchObject({ refusalMinCount: 4, refusalMinPercent: 50, maxReruns: 3, tokenExpiryWarnDays: 7, watchdog: true, staleAfterMinutes: 45 });
    const bad: [string, RegExp][] = [
      ["refusalMinCount: 2.5\n", /refusalMinCount: expected a whole number/],
      ["refusalMinPercent: high\n", /refusalMinPercent/],
      ["maxReruns: 1000\n", /maxReruns/],
      ["tokenExpiryWarnDays: -1\n", /tokenExpiryWarnDays/],
      ["watchdog: maybe\n", /watchdog/],
      ["staleAfterMinutes: 1\n", /staleAfterMinutes/],
    ];
    for (const [yaml, re] of bad) expect(() => buildConfig({ ...base, "config-file": yamlFile(yaml) })).toThrow(re);
  });

  it("watchdog mode needs a state repo but no repository selection", () => {
    expect(buildConfig({ token: "tok", owner: "me", "state-repo": "s", watchdog: "true" })).toMatchObject({ watchdog: true, stateRepo: "s", repos: [] });
    expect(() => buildConfig({ token: "tok", owner: "me", watchdog: "true" })).toThrow(/state-repo is required/);
  });
});
