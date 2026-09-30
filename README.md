# ⏱️ Overtime

**When GitHub's free Actions minutes run out, your runners clock in.**

Overtime keeps your private repos on **GitHub-hosted runners while your plan's included minutes last**, then
switches them to **your self-hosted runners** when the minutes are spent (or GitHub starts refusing jobs), and
switches back when the billing cycle resets. No Kubernetes, no webhooks, no paid overage by surprise.

```yaml
# In every workflow you want routed (one line):
runs-on: ${{ fromJSON(vars.CI_RUNS_ON || '"ubuntu-latest"') }}
```

Overtime runs on a schedule, reads your Actions usage from GitHub's billing API, and sets that `CI_RUNS_ON`
repository variable in each managed repo.

## Why

GitHub-hosted runners are free up to your plan's included minutes (2,000/month on Free, 3,000 on Pro), and
[self-hosted runners are free and don't count against them](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
But GitHub can't do "hosted first, self-hosted when the minutes are gone":

- `runs-on` is static. When the minutes run out with a $0 spending limit, private-repo jobs simply
  [don't start](https://github.com/orgs/community/discussions/165506) until next month.
- With a spending limit set, every repo quietly starts billing, including the ones you'd happily run at home.
- Existing fallback actions route the other way (self-hosted first, hosted when your runners are offline).

Overtime is the missing direction, and it works per repo, so you can pay for one project's minutes and keep
the rest on your own hardware.

## How it works

```
every 10 min (on your self-hosted runner, so it works even when minutes are gone)
  │
  ├─ read this month's Actions usage  ── GET /users|organizations/{owner}/settings/billing/usage/summary
  ├─ look for jobs GitHub refused     ── failed, never got a runner, annotation mentions billing
  ├─ decide:  forced? → refused? → any minutes billed? → used ≥ switch-at-percent? → sticky until next cycle
  ├─ write CI_RUNS_ON in each managed repo (only when it changes)
  ├─ re-run jobs GitHub refused (once switched to self-hosted)
  └─ post to Discord/Slack/webhook when the mode changes
```

The decision is a pure function ([`src/decide.ts`](src/decide.ts)) with every branch tested.

## Quick start

### 1. Create a token

A **fine-grained personal access token** (Settings → Developer settings → Fine-grained tokens):

| Scope | Permission | Why |
|---|---|---|
| Repository access | Only the repos Overtime manages, plus the repo running it | least privilege |
| Repository → Variables | Read and write | set `CI_RUNS_ON`, keep state |
| Repository → Actions | Read and write | find refused jobs, re-run them (read-only works if `rerun-refused: false`) |
| Account → Plan | Read | read your Actions billing usage and your plan's included minutes |

For an **organization**, grant the org's **Administration: Read** (billing usage) instead of Plan. Save the token as
a secret, e.g. `OVERTIME_TOKEN`.

### 2. Run Overtime on a schedule, on a self-hosted runner

```yaml
# .github/workflows/overtime.yml (in any repo that has a self-hosted runner)
name: Overtime
on:
  schedule: [{ cron: "*/10 * * * *" }]
  workflow_dispatch:
permissions: {}
jobs:
  route:
    runs-on: [self-hosted]   # must not need hosted minutes, or it stops when they run out
    timeout-minutes: 5
    steps:
      - uses: shawnazar/overtime@v0
        with:
          token: ${{ secrets.OVERTIME_TOKEN }}
          repos: |
            my-app
            my-site
          self-hosted-runs-on: '["self-hosted", "linux"]'
          notify: ${{ secrets.OVERTIME_DISCORD_WEBHOOK }}
```

Or run the container anywhere (a NAS, a Pi, a VPS), no runner needed:

```sh
docker run -d --name overtime --restart unless-stopped \
  -e OVERTIME_TOKEN=... -e OVERTIME_OWNER=you -e OVERTIME_REPOS=my-app,my-site \
  -e OVERTIME_STATE_REPO=my-app \
  ghcr.io/shawnazar/overtime:0
```

### 3. Point your workflows at the variable

```yaml
jobs:
  test:
    runs-on: ${{ fromJSON(vars.CI_RUNS_ON || '"ubuntu-latest"') }}
```

The `|| '"ubuntu-latest"'` fallback keeps workflows working before Overtime's first run.

## Configuration

Every setting is an action input, an `OVERTIME_*` environment variable (container/CLI; `switch-at-percent` →
`OVERTIME_SWITCH_AT_PERCENT`), or a key in a YAML `config-file` (camelCase). Explicit inputs win over the file.

| Setting | Default | What it does |
|---|---|---|
| `token` | (required) | Fine-grained PAT, see above |
| `owner` | repo owner | User or org that owns the repos and the bill |
| `owner-type` | `auto` | `auto`, `user`, `organization` |
| `repos` | | Repos to manage, comma/newline separated |
| `repos-include` | | Globs matched against all your repos (`api-*`) |
| `repos-exclude` | | Globs to skip, e.g. a repo you pay for |
| `repos-topic` | | Only repos with this topic |
| `include-archived` / `include-forks` | `false` | Discovery filters |
| `variable` | `CI_RUNS_ON` | Variable written to each repo |
| `hosted-runs-on` | `ubuntu-latest` | Label or JSON (`["ubuntu-latest"]`, `{"group":"x","labels":[...]}`) |
| `self-hosted-runs-on` | `["self-hosted"]` | Label or JSON |
| `included-minutes` | `auto` | Your plan's monthly allowance; `auto` reads the plan (Free 2,000, Pro/Team 3,000) |
| `switch-at-percent` | `90` | Switch when this much of the allowance is used. Leave headroom for queued jobs |
| `switch-back` | `next-cycle` | `next-cycle`, or `below-percent` (e.g. after raising the allowance) |
| `switch-back-percent` | `50` | Used with `below-percent`; must be below `switch-at-percent` |
| `skus` | standard runners | Which Actions minute SKUs count. Default: standard Linux/Windows/macOS runners only, the ones included minutes cover. Larger runners (4-core+, GPU) are billed from minute one and would otherwise read as "minutes spent" on day 1. `all` counts everything; or list substrings (e.g. `linux`) |
| `switch-on-overage` | `true` | Any billed minutes this cycle ⇒ self-hosted |
| `detect-refusals` | `true` | Jobs GitHub won't start for billing reasons ⇒ self-hosted |
| `refusal-evidence` | `auto` | How to recognise a billing refusal: `annotations` (GitHub's message; needs a classic PAT or App), `heuristic` (hosted job failed with no runner and no steps), or `auto` (annotations when readable, else heuristic) |
| `refusal-lookback-minutes` | `120` | Window for refusal detection |
| `rerun-refused` | `true` | Re-run refused jobs after switching |
| `mode` | `auto` | `hosted` / `self-hosted` pins everything |
| `force-variable` | `OVERTIME_FORCE` | Set this variable in the state repo to `hosted`/`self-hosted` to override without a deploy |
| `state-repo` | running repo | Where Overtime stores its state |
| `state-variable` | `OVERTIME_STATE` | Last decision (JSON), for hysteresis and change notifications |
| `notify` | | `discord:https://…`, `slack:https://…`, `generic:https://…`, or bare URLs |
| `dry-run` | `false` | Decide and report only |
| `config-file` | | YAML with any of the above plus per-repo `overrides` |
| `api-url` | `https://api.github.com` | GitHub Enterprise Server API URL |

### Config file and per-repo overrides

```yaml
# overtime.yml
includedMinutes: 3000
switchAtPercent: 85
reposInclude: ["*"]
reposExclude: ["paid-project", "*-archive"]
selfHosted: ["self-hosted", "linux", "x64"]
overrides:
  big-monorepo:
    selfHosted: ["self-hosted", "linux", "16gb"]   # a beefier runner
  docs:
    mode: hosted          # always GitHub-hosted (e.g. it's public)
  legacy-app:
    variable: LEGACY_RUNS_ON
```

### Outputs

`mode`, `changed`, `reason`, `percent-used`, `minutes-used`, `minutes-billed`, `repos`, `runs-on`. Each run also
writes a job summary with the usage table and what changed per repo.

## Self-hosted runners for many repos

On a personal account, a self-hosted runner serves one repository. Overtime only decides *where* jobs go; to
have runners appear on demand for any repo, pair it with an ephemeral-runner manager such as
[GARM](https://github.com/cloudbase/garm) (Docker provider) or [runscaler](https://github.com/ysya/runscaler).
Label those runners to match `self-hosted-runs-on`.

## Security

- The token can change repo variables. Scope it to only the managed repos; store it as a secret.
- Overtime writes only the variables you name (`variable`, `state-variable`) and re-runs only jobs it detected as
  billing refusals. It never reads secrets or code.
- Zero runtime dependencies beyond `yaml`; GitHub is called with Node's built-in `fetch`.
- **Never attach self-hosted runners to public repositories:** anyone can open a pull request and run code on
  them. Keep public repos on `hosted` (they're free anyway) via `overrides` or `repos-exclude`.
- Releases carry build provenance attestations. Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## FAQ

**Why must the Overtime job itself run on a self-hosted runner?** When minutes run out, hosted jobs stop,
including a hosted Overtime job, so it could never switch you over. Or use the container.

**Does GitHub charge for self-hosted runners?** Not today. GitHub
[announced a per-minute platform fee and postponed it](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/);
the current docs say self-hosted usage is free. Overtime doesn't assume either way: it only reads what you're billed.

**Why a heuristic for refused jobs?** Fine-grained tokens can't read check-run annotations (GitHub returns
403), so Overtime can't see GitHub's "spending limit" message with them. A GitHub-hosted job that failed without
ever getting a runner or running a step is what a billing refusal looks like; `refusal-evidence: annotations`
opts out of the heuristic.

**We use larger runners. Will that trip Overtime?** No. Larger runners are never covered by included minutes, so by default
Overtime ignores their SKUs; only standard-runner usage counts toward the threshold and the overage rule.

**macOS/Windows minutes count double/10x.** GitHub reports minute quantities as billed; Overtime uses those, and
`skus` lets you count only the runner types you care about.

**Will switching affect running jobs?** No. `runs-on` is read when a job is queued; running jobs finish where they are.

## License

[MIT](LICENSE)
