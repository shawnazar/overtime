import { describe, it, expect } from "vitest";
import { parseDuration } from "../src/duration.js";

describe("parseDuration", () => {
  it("parses seconds, minutes and hours; bare numbers are minutes", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("60s")).toBe(60_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration(" 1h ")).toBe(3_600_000);
    expect(parseDuration("15")).toBe(900_000);
  });

  it("rejects malformed values", () => {
    for (const s of ["", "abc", "10x", "1.5m", "-5m", "m", "10 m"]) {
      expect(() => parseDuration(s)).toThrow(/invalid interval/);
    }
  });

  it("rejects intervals under one minute", () => {
    expect(() => parseDuration("59s")).toThrow(/at least 1m/);
    expect(() => parseDuration("0")).toThrow(/at least 1m/);
  });
});
