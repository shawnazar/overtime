import { readFileSync } from "node:fs";
import { GitHubClient } from "../src/github.js";
import { DEFAULTS, type Config } from "../src/config.js";

export interface Call {
  method: string;
  url: URL;
  path: string;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Router: return a Reply, or undefined for a 404. */
export type Route = (call: Call) => Reply | undefined;

/** A fake fetch that records every call and answers from `route`. */
export function fakeFetch(route: Route): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = route(call) ?? { status: 404, body: { message: "Not Found" } };
    const status = r.status ?? 200;
    const text = r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(status === 204 ? null : text, { status, headers: r.headers });
  };
  return { fetch: f as typeof fetch, calls };
}

export function client(route: Route, maxRetries?: number): { gh: GitHubClient; calls: Call[]; sleeps: number[] } {
  const { fetch, calls } = fakeFetch(route);
  const sleeps: number[] = [];
  const gh = new GitHubClient({
    token: "test-token",
    fetchImpl: fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  });
  return { gh, calls, sleeps };
}

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export function config(over: Partial<Config> = {}): Config {
  return { ...DEFAULTS, includedMinutes: 2000, includedMinutesAuto: false, token: "test-token", owner: "me", stateRepo: "a", repos: ["a", "b"], ...over };
}
