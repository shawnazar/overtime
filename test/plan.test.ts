import { describe, it, expect } from "vitest";
import { includedMinutesFor, INCLUDED_MINUTES } from "../src/plan.js";
import { client } from "./helpers.js";

describe("includedMinutesFor", () => {
  it("maps a user's plan to included minutes", async () => {
    const { gh } = client((c) => (c.path === "/users/me" ? { body: { plan: { name: "pro" } } } : undefined));
    expect(await includedMinutesFor(gh, "me", "user")).toEqual({ minutes: 3000, plan: "pro" });
  });

  it("uses /orgs for organizations", async () => {
    const { gh, calls } = client((c) => (c.path === "/orgs/acme" ? { body: { plan: { name: "team" } } } : undefined));
    expect((await includedMinutesFor(gh, "acme", "organization")).minutes).toBe(3000);
    expect(calls[0]!.path).toBe("/orgs/acme");
  });

  it("explains how to fix a token that can't see the plan", async () => {
    const { gh } = client((c) => (c.path === "/users/me" ? { body: { login: "me" } } : undefined));
    await expect(includedMinutesFor(gh, "me", "user")).rejects.toThrow(/Plan: Read/);
  });

  it("rejects unknown plans instead of guessing", async () => {
    const { gh } = client((c) => (c.path === "/users/me" ? { body: { plan: { name: "mystery" } } } : undefined));
    await expect(includedMinutesFor(gh, "me", "user")).rejects.toThrow(/set included-minutes/);
  });

  it("knows Free and Pro allowances", () => {
    expect(INCLUDED_MINUTES.free).toBe(2000);
    expect(INCLUDED_MINUTES.pro).toBe(3000);
  });
});
