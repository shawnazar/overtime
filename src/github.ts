// Minimal GitHub REST client on Node's built-in fetch. No SDK on purpose: this action runs
// with a token that can change repo settings, so every dependency is attack surface.

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`GitHub API ${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
    this.name = "GitHubError";
  }
}

export interface GitHubClientOptions {
  token: string;
  apiUrl?: string;
  userAgent?: string;
  /** Retries for 5xx and secondary rate limits. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | boolean | undefined>;

export class GitHubClient {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * When the token expires, from GitHub's `github-authentication-token-expiration` response header
   * (sent for expiring tokens such as fine-grained PATs). Undefined until a response carries it.
   */
  tokenExpiresAt: Date | undefined;

  constructor(private readonly opts: GitHubClientOptions) {
    this.apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Follows Link: rel="next" and concatenates `key` (or the array body itself). */
  async paginate<T>(path: string, query: Query = {}, key?: string, limit = 1000): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = this.url(path, { per_page: 100, ...query });
    while (url && out.length < limit) {
      const res = await this.raw("GET", url, {});
      const body = JSON.parse(await res.text());
      const page: T[] = key ? (body?.[key] ?? []) : body;
      out.push(...page);
      url = nextLink(res.headers.get("link"));
    }
    return out.slice(0, limit);
  }

  private url(path: string, query: Query = {}): string {
    const u = new URL(path.startsWith("http") ? path : `${this.apiUrl}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async raw(method: string, pathOrUrl: string, opts: { query?: Query; body?: unknown }): Promise<Response> {
    const url = this.url(pathOrUrl, opts.query);
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.opts.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": this.opts.userAgent ?? "overtime",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const expires = parseTokenExpiration(res.headers.get("github-authentication-token-expiration"));
      if (expires) this.tokenExpiresAt = expires;
      if (res.ok) return res;
      const text = await res.text();
      const retryable = res.status >= 500 || (res.status === 403 && /secondary rate limit/i.test(text)) || res.status === 429;
      if (retryable && attempt < maxRetries) {
        const after = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new GitHubError(res.status, method, new URL(url).pathname, text);
    }
  }
}

export function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * GitHub sends e.g. "2027-09-29 00:00:00 UTC"; tolerate "…T…", offsets like "-0700"/"+05:30", "Z",
 * a missing seconds field or a bare date (read as UTC midnight). Anything else: undefined.
 */
export function parseTokenExpiration(v: string | null | undefined): Date | undefined {
  if (!v) return undefined;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?)?\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return undefined;
  const [, date, hm = "00:00", sec = ":00", zone = "Z"] = m;
  const tz = /^(UTC|GMT|Z)$/i.test(zone) ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const d = new Date(`${date}T${hm}${sec}${tz}`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
