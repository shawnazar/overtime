import type { GitHubClient } from "./github.js";
import { GitHubError } from "./github.js";

export interface Refusal {
  repo: string;
  runId: number;
  jobName: string;
  reason: string;
  /**
   * annotation: GitHub's own billing message was read from the job's annotations (conclusive).
   * heuristic:  a hosted job failed without a runner or steps; an outage or a typo'd label looks the same.
   */
  evidence: "annotation" | "heuristic";
}

export type RefusalEvidence = "auto" | "annotations" | "heuristic";

interface Run { id: number }
interface Job { id: number; name: string; conclusion: string | null; runner_name: string | null; steps?: unknown[]; labels?: string[] }
interface Annotation { message?: string }

// Messages GitHub attaches when it won't start hosted jobs for billing reasons.
export const BILLING_PATTERNS = [
  /spending limit/i,
  /recent account payments have failed/i,
  /included minutes/i,
  /billing/i,
];

// Labels only GitHub-hosted runners carry. Billing refusals only happen to hosted jobs.
const HOSTED_LABEL = /^(ubuntu|windows|macos)-/i;

/** Never got a runner: failed with no runner_name and no steps. */
export function neverStarted(job: Job): boolean {
  return job.conclusion === "failure" && !job.runner_name && (job.steps?.length ?? 0) === 0;
}

export function wantedHosted(job: Job): boolean {
  return (job.labels ?? []).some((l) => HOSTED_LABEL.test(l));
}

/**
 * Jobs GitHub refused to start for billing reasons in the lookback window.
 *
 * Evidence:
 *  - annotations: the job's check-run annotation mentions billing (spending limit, failed
 *    payment). Most precise, but fine-grained PATs cannot read annotations (403).
 *  - heuristic:   failed, never got a runner, no steps, and asked for a GitHub-hosted label.
 *  - auto:        annotations when readable, heuristic when the token gets 403.
 */
export async function findRefusals(
  gh: GitHubClient, owner: string, repos: string[], since: Date,
  evidence: RefusalEvidence = "auto", maxRunsPerRepo = 20,
): Promise<Refusal[]> {
  const out: Refusal[] = [];
  const created = `>=${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  let annotationsReadable = evidence !== "heuristic";
  for (const repo of repos) {
    const runs = await gh.paginate<Run>(`/repos/${owner}/${repo}/actions/runs`, { status: "failure", created }, "workflow_runs", maxRunsPerRepo);
    for (const run of runs) {
      const jobs = await gh.paginate<Job>(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`, { filter: "latest" }, "jobs", 100);
      for (const job of jobs.filter(neverStarted)) {
        if (annotationsReadable) {
          try {
            // A job's id is also its check-run id.
            const anns = await gh.paginate<Annotation>(`/repos/${owner}/${repo}/check-runs/${job.id}/annotations`, {}, undefined, 20);
            const hit = anns.find((a) => BILLING_PATTERNS.some((p) => p.test(a.message ?? "")));
            if (hit) out.push({ repo, runId: run.id, jobName: job.name, reason: hit.message!.slice(0, 200), evidence: "annotation" });
            continue;
          } catch (e) {
            if (e instanceof GitHubError && e.status === 404) continue; // no annotations: no billing evidence
            if (!(e instanceof GitHubError && e.status === 403) || evidence === "annotations") throw e;
            annotationsReadable = false; // fine-grained PAT: fall through to the heuristic from now on
          }
        }
        if (wantedHosted(job)) {
          out.push({ repo, runId: run.id, jobName: job.name, reason: `hosted job never started (${(job.labels ?? []).join(", ")}): no runner, no steps`, evidence: "heuristic" });
        }
      }
    }
  }
  return out;
}
