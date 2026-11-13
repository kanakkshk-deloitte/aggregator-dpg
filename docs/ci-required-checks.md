# CI Required Status Checks

A repo admin must configure branch protection on `main` (and any `v0.*` release branches) to require the following status checks before merging.

## How to configure

GitHub → Repository settings → Branches → Branch protection rules → `main` → **Require status checks to pass before merging**.

Add each check name exactly as listed below (copy-paste — GitHub matches by exact string).

## Required checks

| Check name | What it gates                              |
| ---------- | ------------------------------------------ |
| `CI`       | Lint + typecheck + test + build on Node 24 |

> The check name comes from the `name:` field of the `ci` job in `ci.yml`.
> If the job name ever changes, update this doc and re-pin the checks.

## Advisory checks (not required)

| Check name                 | What it reports                                                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SonarCloud Code Analysis` | Coverage + code-quality gate, posted by SonarCloud                                                                                                                                                                                                                                |
| `db-integration`           | Real-Postgres integration suites (`*.integration.test.ts`) on `postgres:16`, run on the full migration set (the expand-phase run through 0025 was retired with migration 0027: the user & org release train applies 0023–0027 in one transaction, so no instance can sit at 0025) |

`db-integration` starts **advisory** while it proves stable. Promote it to required
once it has run green on a few PRs: it is the only check that executes the SQL
migrations and the database triggers for real.

This check is **deliberately not in the required list**. It is posted by SonarCloud
(project `Blue-Dots-Economy_aggregator-dpg`, org `blue-dots-economy`) after the
`SonarCloud scan` step in the `ci` job, and currently fails its gate — so requiring
it would block every merge. Treat it as a signal to act on, not a merge blocker,
until coverage and the security rating are green.

### How it is wired

- Analysis is **CI-based**; SonarCloud's own "Automatic Analysis" is switched off
  (both cannot run against one project).
- `sonar-project.properties` at the repo root holds the project/org keys, source and
  test inclusions, and one `lcov.info` path per app/package.
- The `Generate coverage reports (for SonarCloud)` step runs `pnpm -w test:coverage`
  and is `continue-on-error: true` **on purpose**: a few packages sit below their own
  local vitest thresholds, and that must not fail the build. The separate `Test` step
  is what actually gates. Do not "tidy" these into one step — that re-introduces the
  coupling.
- The `SonarCloud scan` step is **also** `continue-on-error: true`, for a different
  reason: `CI` is the one required check, so a scan that fails for reasons unrelated
  to the code — a SonarCloud outage, an expired token, the quality gate — must not
  redden it. Scan failures show up in the run log and in SonarCloud's own commit
  check instead. (This used to be justified by the `docker` matrix depending on the
  `ci` job; that matrix now lives in `build-images.yml` and no longer depends on CI.)
- `SONAR_TOKEN` lives in repo Actions secrets. Checkout uses `fetch-depth: 0` so
  Sonar can attribute new code to the right commits.
- The token is exposed as a **job-level** `env` so the scan step can gate on it with
  `if: env.SONAR_TOKEN != ''` (the `secrets` context is not available in a step `if:`,
  and a step's own `env:` block is not in scope for its own `if:`). Runs without the
  secret — Dependabot-raised and fork pull requests, which GitHub deliberately denies
  repo secrets — therefore **skip** the scan instead of failing it. Before this gate,
  every Dependabot PR went red on `exit code 3` / "Not authorized or project not
  found" even when lint, type-check, test and build all passed. This complements the
  bullet above rather than replacing it: `continue-on-error` handles a scan that runs
  and fails, the `if:` handles one that could never authenticate in the first place.

### The 80%-vs-70% gap

The repo's documented standard is **≥70% line coverage** (`.claude/rules/testing-requirements.md`),
but the gate in force is SonarCloud's built-in `Sonar way`, which requires **≥80% coverage
on new code**. These cannot currently be reconciled: the organisation is on the **free plan**,
which allows _creating_ a custom quality gate but not _associating_ one with a project
("Your current plan does not allow you to associate a quality gate other than Sonar way").
Closing the gap needs a plan upgrade. Note the project has _Ignore duplication and coverage
on small changes_ enabled, so coverage conditions are skipped until a change adds ≥20 new lines.

## Recommended additional settings

- **Require branches to be up to date before merging** — prevents stale-branch merges.
- **Do not allow bypassing the above settings** — prevents admins from merging broken PRs.
- **Restrict who can push to matching branches** — limit to release managers only.
