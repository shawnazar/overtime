# Security Policy

Overtime runs with a token that can change repository Actions variables, re-run
workflows, and read your account's billing usage. Please treat both the token and
any vulnerability in Overtime with that in mind.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release of the current major (`v0.x` today, via the moving `v0` tag) | Yes |
| Older releases | No. Upgrade to the latest release. |

Fixes ship as a new patch release and the major tag (`v0`, later `v1`, ...) is moved
to it, so workflows pinned to the major tag pick them up automatically. Workflows
pinned to a commit SHA (recommended) must update the SHA; Dependabot will propose it.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security problem.**

Report it privately through GitHub Security Advisories:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, affected versions, and steps to reproduce. A minimal
   proof of concept helps a great deal.

Direct link: <https://github.com/shawnazar/overtime/security/advisories/new>

### What to expect

This is a single-maintainer project, so these are good-faith targets rather than an SLA:

- **Acknowledgement** within 3 business days.
- **Initial assessment** (confirmed / not a vulnerability / need more information)
  within 7 days.
- **Fix or mitigation** for confirmed issues as fast as severity warrants; critical
  issues are prioritised over everything else.
- You'll be kept informed in the advisory thread, and credited in the published
  advisory unless you prefer otherwise.

Please give a reasonable window to release a fix before disclosing publicly.

## Token safety

Overtime needs a token; how you create and store it matters more than anything
in this codebase.

**Use a fine-grained personal access token**, not a classic PAT:

- **Repository access:** *Only select repositories*. Choose exactly the
  repositories Overtime manages (plus the `state-repo`, if you use one). Never
  "All repositories" unless you really do manage all of them.
- **Repository permissions** (the minimum):
  - **Variables:** Read and write (reads and sets the `runs-on` variable)
  - **Actions:** Read and write (reads failed runs to detect refusals; write is
    only for re-running refused jobs, so Read is enough if `rerun-refused: false`)
  - **Metadata:** Read (granted automatically)
  - **Administration: not needed.** Do not grant it.
- **Account permissions:** **Plan:** Read (billing usage and included minutes for a personal account).
  For an organization, billing usage instead needs the organization permission
  **Administration:** Read.
- **Expiration:** set one, and rotate before it lapses.

**Store it as an Actions secret** (for example `OVERTIME_TOKEN`) and pass it as
`token: ${{ secrets.OVERTIME_TOKEN }}`. Never commit it, put it in the config file
(Overtime refuses to read one there), or echo it in a step.

**Never run Overtime's own workflows, or any untrusted pull request, on
self-hosted runners.** Pull requests from forks can execute arbitrary code on the
runner that picks them up. Overtime's own CI is pinned to GitHub-hosted runners for
this reason. In your repositories, keep `pull_request` workflows from forks on
GitHub-hosted runners, or require approval for fork runs, even when Overtime has
switched the rest of your jobs to self-hosted.
