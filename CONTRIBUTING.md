# Contributing to Overtime

Thanks for helping. Bug reports, fixes, and focused features are all welcome.

## Development setup

Requirements: **Node.js 24** (the action runs on the `node24` runtime).

```bash
git clone https://github.com/shawnazar/overtime.git
cd overtime
npm ci --ignore-scripts
npm run check        # typecheck + tests + build
```

Individual steps: `npm run typecheck`, `npm test`, `npm run build`.

The repository's `.npmrc` sets `ignore-scripts=true`, so dependency install
scripts never run on your machine or in CI. Keep it that way.

## `dist/` must be committed

GitHub runs a JavaScript action straight from the repository at the ref a workflow
pins. There is no install or build step, so the bundled `dist/index.cjs` (the
action) and `dist/cli.cjs` (the CLI / container) must be in the commit.

After changing anything in `src/`, run `npm run build` and commit `dist/` in the
same pull request. CI rebuilds and fails if `dist/` differs from the build of
`src/`, so reviewers can trust that the committed bundle is the reviewed source.

## Pull requests

- **Tests are required** for behaviour changes and bug fixes (`vitest`, under `test/`).
  A bug fix should include a test that fails without it.
- Keep changes focused; one concern per pull request.
- Update the README when inputs, outputs, or behaviour change.
- [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
  `docs:`, `chore:` ...) are welcome and make release notes nicer, but not required.

## Dependencies: think twice

Overtime handles a token that can modify repository variables and read billing
data, and everything in `dependencies` is bundled into `dist/` and runs with that
token. Every new dependency is supply-chain risk.

- Prefer the Node.js standard library (`fetch`, `fs`, `crypto`, ...) over a package.
- If a dependency is truly needed, explain why in the PR and pin an exact version
  (`save-exact=true` is set in `.npmrc`).
- Never add a dependency that needs an install script.
- Dependabot proposes updates weekly; don't bundle unrelated upgrades into a feature PR.

## Security issues

Please don't report vulnerabilities in issues or pull requests. See
[SECURITY.md](SECURITY.md).

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
