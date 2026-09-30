import type { GitHubClient } from "./github.js";

export interface Refusal {
  repo: string;
  runId: number;
  jobName: string;
  reason: string;
}

interface Run { id: number }
interface Job { id: number; name: string; conclusion: string | null; runner_name: string | null; steps?: unknown[] }
interface Annotation { message?: string }

// Messages GitHub attaches when it won't start hosted jobs for billing reasons.
export const BILLING_PATTERNS = [
  /spending limit/i,
  /recent account payments have failed/i,
  /included minutes/i,
  /billing/i,
];

/** Never got a runner: failed with no runner_name and no steps. */
export function neverStarted(job: Job): boolean {
  return job.conclusion === "failure" && !job.runner_name && (job.steps?.length ?? 0) === 0;
}

/**
 * Jobs GitHub refused to start for billing reasons in the lookback window. Only counts a
 * job when its annotation mentions billing, so ordinary startup failures don't flip modes.
 */
export async function findRefusals(gh: GitHubClient, owner: string, repos: string[], since: Date, maxRunsPerRepo = 20): Promise<Refusal[]> {
  const out: Refusal[] = [];
  const created = `>=${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  for (const repo of repos) {
    const runs = await gh.paginate<Run>(`/repos/${owner}/${repo}/actions/runs`, { status: "failure", created }, "workflow_runs", maxRunsPerRepo);
    for (const run of runs) {
      const jobs = await gh.paginate<Job>(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`, { filter: "latest" }, "jobs", 100);
      for (const job of jobs.filter(neverStarted)) {
        // A job's id is also its check-run id.
        const anns = await gh.paginate<Annotation>(`/repos/${owner}/${repo}/check-runs/${job.id}/annotations`, {}, undefined, 20).catch(() => []);
        const hit = anns.find((a) => BILLING_PATTERNS.some((p) => p.test(a.message ?? "")));
        if (hit) out.push({ repo, runId: run.id, jobName: job.name, reason: hit.message!.slice(0, 200) });
      }
    }
  }
  return out;
}
