import { describe, it, expect } from "vitest";
import { neverStarted, findRefusals } from "../src/refusals.js";
import { client } from "./helpers.js";

const job = (id: number, over: Partial<{ name: string; conclusion: string | null; runner_name: string | null; steps: unknown[]; labels: string[] }> = {}) => ({
  id, name: over.name ?? `job-${id}`, conclusion: over.conclusion === undefined ? "failure" : over.conclusion,
  runner_name: over.runner_name ?? null, steps: over.steps ?? [], labels: over.labels ?? [],
});

describe("neverStarted", () => {
  it("is true only for failed jobs with no runner and no steps", () => {
    expect(neverStarted(job(1))).toBe(true);
    expect(neverStarted({ ...job(1), steps: undefined })).toBe(true);
    expect(neverStarted(job(1, { runner_name: "GitHub Actions 3" }))).toBe(false);
    expect(neverStarted(job(1, { steps: [{ name: "checkout" }] }))).toBe(false);
    expect(neverStarted(job(1, { conclusion: "cancelled" }))).toBe(false);
    expect(neverStarted(job(1, { conclusion: null }))).toBe(false);
  });
});

describe("findRefusals", () => {
  const billing = "The job was not started because your account is locked due to a billing issue.";
  const route = (c: { path: string }) => {
    switch (c.path) {
      case "/repos/me/a/actions/runs":
        return { body: { workflow_runs: [{ id: 100 }, { id: 101 }] } };
      case "/repos/me/b/actions/runs":
        return { body: { workflow_runs: [] } };
      case "/repos/me/a/actions/runs/100/jobs":
        return {
          body: {
            jobs: [
              job(1, { name: "billing-refused" }),
              job(2, { name: "ran-and-failed", runner_name: "GitHub Actions 1", steps: [{}] }),
              job(3, { name: "not-billing" }),
              job(4, { name: "no-annotations" }),
            ],
          },
        };
      case "/repos/me/a/actions/runs/101/jobs":
        return { body: { jobs: [job(5, { name: "spending" })] } };
      case "/repos/me/a/check-runs/1/annotations":
        return { body: [{ message: "unrelated" }, { message: billing }] };
      case "/repos/me/a/check-runs/2/annotations":
        return { body: [{ message: billing }] }; // job actually ran: must not be counted
      case "/repos/me/a/check-runs/3/annotations":
        return { body: [{ message: "No runner matching the labels [gpu] was found" }] };
      case "/repos/me/a/check-runs/5/annotations":
        return { body: [{ message: "The job was not started because you have reached your spending limit." }] };
      default:
        return undefined; // job 4 annotations 404 -> treated as none
    }
  };

  it("counts only never-started jobs with billing annotations", async () => {
    const { gh, calls } = client(route);
    const since = new Date("2026-09-15T10:00:00.123Z");
    const r = await findRefusals(gh, "me", ["a", "b"], since);
    expect(r).toEqual([
      { repo: "a", runId: 100, jobName: "billing-refused", reason: billing },
      { repo: "a", runId: 101, jobName: "spending", reason: "The job was not started because you have reached your spending limit." },
    ]);
    const runsCall = calls.find((c) => c.path === "/repos/me/a/actions/runs")!;
    expect(runsCall.url.searchParams.get("status")).toBe("failure");
    expect(runsCall.url.searchParams.get("created")).toBe(">=2026-09-15T10:00:00Z");
    expect(calls.find((c) => c.path.endsWith("/jobs"))!.url.searchParams.get("filter")).toBe("latest");
    // Annotations are only fetched for never-started jobs.
    expect(calls.some((c) => c.path === "/repos/me/a/check-runs/2/annotations")).toBe(false);
  });

  it("truncates long reasons to 200 characters", async () => {
    const long = "billing " + "x".repeat(500);
    const { gh } = client((c) =>
      c.path.endsWith("/actions/runs") ? { body: { workflow_runs: [{ id: 1 }] } }
      : c.path.endsWith("/jobs") ? { body: { jobs: [job(9)] } }
      : { body: [{ message: long }] });
    const [r] = await findRefusals(gh, "me", ["a"], new Date());
    expect(r!.reason).toHaveLength(200);
  });

  it("returns [] when there are no failed runs", async () => {
    const { gh } = client(() => ({ body: { workflow_runs: [] } }));
    expect(await findRefusals(gh, "me", ["a"], new Date())).toEqual([]);
  });
});

describe("findRefusals with a fine-grained PAT (annotations 403)", () => {
  const route = (c: { path: string }) => {
    switch (c.path) {
      case "/repos/me/a/actions/runs":
        return { body: { workflow_runs: [{ id: 200 }] } };
      case "/repos/me/a/actions/runs/200/jobs":
        return {
          body: {
            jobs: [
              job(10, { name: "hosted-refused", labels: ["ubuntu-latest"] }),
              job(11, { name: "self-hosted-never-started", labels: ["self-hosted", "linux"] }),
              job(12, { name: "hosted-ran", labels: ["ubuntu-24.04"], runner_name: "GitHub Actions 2", steps: [{}] }),
            ],
          },
        };
      default:
        if (/\/check-runs\/\d+\/annotations$/.test(c.path)) {
          return { status: 403, body: { message: "Resource not accessible by personal access token" } };
        }
        return undefined;
    }
  };

  it("auto falls back to the hosted-label heuristic when annotations are forbidden", async () => {
    const { gh } = client(route);
    const r = await findRefusals(gh, "me", ["a"], new Date(), "auto");
    expect(r.map((x) => x.jobName)).toEqual(["hosted-refused"]);
    expect(r[0]!.reason).toMatch(/ubuntu-latest/);
  });

  it("heuristic never calls the annotations endpoint", async () => {
    const { gh, calls } = client(route);
    await findRefusals(gh, "me", ["a"], new Date(), "heuristic");
    expect(calls.some((c) => /annotations/.test(c.path))).toBe(false);
  });

  it("annotations-only surfaces the 403 instead of guessing", async () => {
    const { gh } = client(route);
    await expect(findRefusals(gh, "me", ["a"], new Date(), "annotations")).rejects.toThrow(/403/);
  });
});
