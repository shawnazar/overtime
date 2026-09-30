import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { SETTINGS, fromActionInputs, fromEnv } from "../src/inputs.js";

const action = parseYaml(readFileSync(new URL("../action.yml", import.meta.url), "utf8")) as { inputs: Record<string, { description: string; default?: unknown }> };

describe("action.yml inputs", () => {
  it("declares exactly the settings Overtime reads", () => {
    expect(Object.keys(action.inputs).sort()).toEqual([...SETTINGS].sort());
  });

  it("has no default: keys (they would override config-file values); defaults are stated in the text", () => {
    for (const [name, input] of Object.entries(action.inputs)) {
      expect(input, name).not.toHaveProperty("default");
    }
    for (const name of ["refusal-min-count", "refusal-min-percent", "max-reruns", "token-expiry-warn-days", "watchdog", "stale-after-minutes"]) {
      expect(action.inputs[name]!.description, name).toMatch(/Default: /);
    }
  });
});

describe("setting sources", () => {
  it("maps action inputs and OVERTIME_* env vars for the new settings", () => {
    expect(fromActionInputs({ "INPUT_STALE-AFTER-MINUTES": "90", INPUT_WATCHDOG: "true" })).toMatchObject({ "stale-after-minutes": "90", watchdog: "true" });
    expect(fromEnv({ OVERTIME_REFUSAL_MIN_COUNT: "3", OVERTIME_MAX_RERUNS: "5", OVERTIME_TOKEN_EXPIRY_WARN_DAYS: "7" }))
      .toMatchObject({ "refusal-min-count": "3", "max-reruns": "5", "token-expiry-warn-days": "7" });
  });
});
