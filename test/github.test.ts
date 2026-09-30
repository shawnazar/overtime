import { describe, it, expect } from "vitest";
import { GitHubClient, GitHubError, nextLink, parseTokenExpiration } from "../src/github.js";
import { client, fakeFetch } from "./helpers.js";

describe("nextLink", () => {
  it("finds rel=next among several relations", () => {
    const link = '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(nextLink(link)).toBe("https://api.github.com/x?page=3");
  });
  it("returns undefined without a next link", () => {
    expect(nextLink(null)).toBeUndefined();
    expect(nextLink("")).toBeUndefined();
    expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeUndefined();
  });
});

describe("GitHubClient.request", () => {
  it("sends auth/version headers, query and JSON body", async () => {
    let seen: RequestInit | undefined;
    const { fetch } = fakeFetch(() => ({ body: { ok: true } }));
    const gh = new GitHubClient({
      token: "secret", apiUrl: "https://ghe.example/api/v3/",
      fetchImpl: (async (u: string, init: RequestInit) => { seen = init; return fetch(u, init); }) as typeof fetch,
    });
    const out = await gh.request("POST", "/things", { query: { a: 1, b: undefined }, body: { x: 1 } });
    expect(out).toEqual({ ok: true });
    const h = seen!.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer secret");
    expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(h["Content-Type"]).toBe("application/json");
    expect(seen!.body).toBe('{"x":1}');
  });

  it("strips a trailing slash from apiUrl and drops undefined query values", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    await new GitHubClient({ token: "t", apiUrl: "https://ghe.example/api/v3/", fetchImpl: fetch }).request("GET", "/x", { query: { a: 1, b: undefined } });
    expect(calls[0]!.url.href).toBe("https://ghe.example/api/v3/x?a=1");
  });

  it("returns undefined for an empty body (204)", async () => {
    const { gh } = client(() => ({ status: 204 }));
    expect(await gh.request("PATCH", "/x", { body: {} })).toBeUndefined();
  });

  it("retries 500 and 429 with backoff, then succeeds", async () => {
    let n = 0;
    const { gh, calls, sleeps } = client(() => {
      n++;
      if (n === 1) return { status: 500, body: "oops" };
      if (n === 2) return { status: 429, body: "slow down" };
      return { body: { done: true } };
    });
    expect(await gh.request("GET", "/x")).toEqual({ done: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("honours Retry-After and retries secondary rate limit 403s", async () => {
    let n = 0;
    const { gh, sleeps } = client(() => (++n === 1 ? { status: 403, body: "You have exceeded a secondary rate limit", headers: { "retry-after": "7" } } : { body: 1 }));
    expect(await gh.request("GET", "/x")).toBe(1);
    expect(sleeps).toEqual([7000]);
  });

  it("throws GitHubError after max retries", async () => {
    const { gh, calls, sleeps } = client(() => ({ status: 502, body: "bad gateway" }), 2);
    const err = (await gh.request("GET", "/x").catch((e: unknown) => e)) as GitHubError;
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ status: 502, method: "GET", path: "/x", body: "bad gateway" });
    expect(err.message).toBe("GitHub API GET /x -> 502: bad gateway");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("does not retry 404 or ordinary 403", async () => {
    for (const status of [404, 403]) {
      const { gh, calls, sleeps } = client(() => ({ status, body: "no" }));
      await expect(gh.request("GET", "/x")).rejects.toMatchObject({ status });
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });
});

describe("GitHubClient.paginate", () => {
  const base = "https://api.github.com";

  it("follows Link rel=next and concatenates pages", async () => {
    const { gh, calls } = client((c) => {
      const page = Number(c.url.searchParams.get("page") ?? "1");
      const headers: Record<string, string> = page < 3 ? { link: `<${base}/items?per_page=100&page=${page + 1}>; rel="next", <${base}/items?page=3>; rel="last"` } : {};
      return { body: [page * 10, page * 10 + 1], headers };
    });
    expect(await gh.paginate<number>("/items", { sort: "name" })).toEqual([10, 11, 20, 21, 30, 31]);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100");
    expect(calls[0]!.url.searchParams.get("sort")).toBe("name");
  });

  it("extracts a keyed array and stops at the limit", async () => {
    const { gh, calls } = client(() => ({ body: { total_count: 99, jobs: [1, 2, 3] }, headers: { link: `<${base}/jobs?page=2>; rel="next"` } }));
    expect(await gh.paginate<number>("/jobs", {}, "jobs", 5)).toEqual([1, 2, 3, 1, 2]);
    expect(calls).toHaveLength(2);
  });

  it("treats a missing key as an empty page", async () => {
    const { gh } = client(() => ({ body: {} }));
    expect(await gh.paginate("/x", {}, "workflow_runs")).toEqual([]);
  });
});

describe("parseTokenExpiration", () => {
  it("parses GitHub's format and common variants", () => {
    expect(parseTokenExpiration("2027-09-29 00:00:00 UTC")!.toISOString()).toBe("2027-09-29T00:00:00.000Z");
    expect(parseTokenExpiration("  2027-09-29 13:45:08 utc ")!.toISOString()).toBe("2027-09-29T13:45:08.000Z");
    expect(parseTokenExpiration("2027-09-29 00:00:00 -0700")!.toISOString()).toBe("2027-09-29T07:00:00.000Z");
    expect(parseTokenExpiration("2027-09-29T00:00:00+05:30")!.toISOString()).toBe("2027-09-28T18:30:00.000Z");
    expect(parseTokenExpiration("2027-09-29T00:00:00Z")!.toISOString()).toBe("2027-09-29T00:00:00.000Z");
    expect(parseTokenExpiration("2027-09-29 10:15 GMT")!.toISOString()).toBe("2027-09-29T10:15:00.000Z");
    expect(parseTokenExpiration("2027-09-29")!.toISOString()).toBe("2027-09-29T00:00:00.000Z");
  });

  it("returns undefined for missing or unparseable values", () => {
    for (const v of [null, undefined, "", "never", "2027-13-45 00:00:00 UTC", "29/09/2027", "2027-09-29 00:00:00 PST"]) {
      expect(parseTokenExpiration(v)).toBeUndefined();
    }
  });
});

describe("GitHubClient.tokenExpiresAt", () => {
  it("is undefined until a response carries the header, then keeps the latest value", async () => {
    let header: string | undefined;
    const { gh } = client(() => ({ body: {}, ...(header ? { headers: { "github-authentication-token-expiration": header } } : {}) }));
    await gh.request("GET", "/x");
    expect(gh.tokenExpiresAt).toBeUndefined();
    header = "2027-09-29 00:00:00 UTC";
    await gh.request("GET", "/x");
    expect(gh.tokenExpiresAt!.toISOString()).toBe("2027-09-29T00:00:00.000Z");
    header = undefined;
    await gh.request("GET", "/x");
    expect(gh.tokenExpiresAt!.toISOString()).toBe("2027-09-29T00:00:00.000Z");
  });

  it("captures the header from error responses too (e.g. a 404 variable lookup)", async () => {
    const { gh } = client(() => ({ status: 404, body: { message: "Not Found" }, headers: { "github-authentication-token-expiration": "2027-01-02 03:04:05 UTC" } }));
    await expect(gh.request("GET", "/x")).rejects.toThrow(GitHubError);
    expect(gh.tokenExpiresAt!.toISOString()).toBe("2027-01-02T03:04:05.000Z");
  });
});
