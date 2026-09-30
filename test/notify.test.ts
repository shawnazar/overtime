import { describe, it, expect, vi } from "vitest";
import { render, notify, type Event } from "../src/notify.js";

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
