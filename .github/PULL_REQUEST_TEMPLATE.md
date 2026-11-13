<!-- Release and promotion PRs: write this with the `release-pr-notes` skill (`/plugin marketplace add Blue-Dots-Economy/bluedots-claude-plugins`, then `/plugin install bluedots-release-tools@bluedots`). -->

## Summary

<!-- What does this PR do and why? -->

## Release Notes

<!--
User-facing changes in this release — delete this comment and list them, e.g.:
- Added the CSV export button to the dashboard
- Fixed OTP expiry on the login screen

If this PR has NO user-facing changes, add the `no-release-notes` label instead.
-->

## Breaking changes / config

<!-- Write `None.` if nothing applies. -->

## What users will notice

<!-- Write `None.` if nothing applies. -->

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor
- [ ] Docs / config

## Checklist

- [ ] `pnpm -w lint` passes
- [ ] `pnpm -w typecheck` passes
- [ ] `pnpm -w test` passes
- [ ] `pnpm dep-check` passes (no import boundary violations)
- [ ] Updated `README.md` / `CLAUDE.md` if setup or behavior changed (else add the `no-doc-update` label)

### If this PR adds or modifies `src/interface.ts` — [interface conventions](../.claude/rules/interfaces.md)

- [ ] Abstract class used (not TS `interface` or `type`)
- [ ] Every method is `abstract` — no default implementations
- [ ] All methods return `Result<T, BaseError>` (not bare throws)
- [ ] Zod schemas follow naming convention (`<Entity>Schema`, inferred type exported)
- [ ] DTOs extend shared primitives (`Filter`, `Paginated<T>`, `Timestamps`) where applicable
- [ ] Only `shared-primitives`, `zod`, `node:*` imported into interface file
- [ ] In-memory fake and testing fake updated to match any signature changes

### If this PR adds or modifies `src/testing/` — [testing conventions](../.claude/rules/testing.md)

- [ ] `ServiceFake` extends the in-memory implementation
- [ ] `seed()` helper covers all entity types the fake manages
- [ ] No real API calls or network access in tests
