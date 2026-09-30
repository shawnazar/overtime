import { describe, it, expect, vi } from "vitest";
import { render, notify, renderAlert, notifyAlert, type Event, type Alert } from "../src/notify.js";

const event: Event = { mode: "self-hosted", previous: "hosted", reason: "92% used", owner: "me", repos: ["a", "b"], percentUsed: 92, dryRun: false };

describe("render", () => {
  it("renders Discord content without mentions", () => {
    const body = render({ format: "discord", url: "https://x" }, event) as { content: string; allowed_mentions: unknown };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain("**Overtime**");
    expect(body.content).toContain("Your runners are on the clock: `hosted` → `self-hosted` for 2 repo(s) under me.");
    expect(body.content).toContain("\n92% used");
  });

  it("truncates Discord content to 1900 characters", () => {
    const body = render({ format: "discord", url: "https://x" }, { ...event, reason: "r".repeat(5000) }) as { content: string };
    expect(body.content).toHaveLength(1900);
  });

  it("renders Slack text with single-asterisk bold", () => {
    const body = render({ format: "slack", url: "https://x" }, { ...event, mode: "hosted", previous: undefined, dryRun: true }) as { text: string };
    expect(body.text).toContain("*Overtime* (dry run) — GitHub-hosted runners are back: `?` → `hosted`");
    expect(body.text).not.toContain("**");
  });

  it("renders generic JSON with the full event", () => {
    expect(render({ format: "generic", url: "https://x" }, event)).toEqual({ event: "overtime.mode_changed", ...event });
  });
});

describe("notify", () => {
  it("posts JSON to every target and collects non-2xx and thrown errors", async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("bad")) return new Response("no", { status: 500 });
      if (url.includes("throw")) throw new Error("ECONNREFUSED");
      return new Response(null, { status: 204 });
    });
    const errors = await notify(
      [
        { format: "discord", url: "https://ok.example" },
        { format: "slack", url: "https://bad.example" },
        { format: "generic", url: "https://throw.example" },
      ],
      event,
      fetchImpl as unknown as typeof fetch,
    );
    expect(errors).toEqual(["slack webhook -> 500", "generic webhook -> ECONNREFUSED"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(init!.body as string)).toHaveProperty("content");
  });

  it("returns [] with no targets", async () => {
    expect(await notify([], event, vi.fn() as unknown as typeof fetch)).toEqual([]);
  });
});

describe("alerts (token expiry, watchdog)", () => {
  const alert: Alert = { kind: "stale", text: "Overtime hasn't run for 90 minutes; CI_RUNS_ON is frozen at self-hosted", data: { minutesSince: 90 } };

  it("renders per format", () => {
    expect(renderAlert({ format: "discord", url: "https://x" }, alert)).toEqual({ content: `⏱️ **Overtime** — ${alert.text}`, allowed_mentions: { parse: [] } });
    expect(renderAlert({ format: "slack", url: "https://x" }, alert)).toEqual({ text: `⏱️ *Overtime* — ${alert.text}` });
    expect(renderAlert({ format: "generic", url: "https://x" }, alert)).toEqual({ event: "overtime.stale", text: alert.text, minutesSince: 90 });
  });

  it("posts to every target and reports failures", async () => {
    const f = vi.fn(async (url: string) => new Response(null, { status: url.includes("bad") ? 500 : 204 }));
    const errs = await notifyAlert([{ format: "generic", url: "https://ok" }, { format: "slack", url: "https://bad" }], alert, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
    expect(errs).toEqual(["slack webhook -> 500"]);
  });
});
