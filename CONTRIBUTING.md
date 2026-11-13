# Contributing

## Prerequisites

- **Node.js** ≥ 24 (use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schickling/fnm))
- **pnpm** ≥ 10 — install via `npm i -g pnpm` or `corepack enable pnpm`

## Setup

```bash
pnpm install
```

This installs all workspace dependencies across `apps/*`, `services/*`, and `packages/*`.

## Common commands

| Command                      | What it does                                   |
| ---------------------------- | ---------------------------------------------- |
| `pnpm -w build`              | Build all packages (topological order, cached) |
| `pnpm -w test`               | Run all tests                                  |
| `pnpm -w lint`               | Lint all packages                              |
| `pnpm -w typecheck`          | Type-check all packages                        |
| `pnpm -w dev`                | Start all packages in dev/watch mode           |
| `pnpm --filter <name> <cmd>` | Run a command in one package only              |

## Workspace layout

```
apps/       application entrypoints (api, web)
services/   standalone services (signal-processing)
packages/   shared libraries consumed by apps and services
```

Package names use the `@aggregator-dpg/` scope.

## Adding a new package

1. Create `packages/<name>/package.json` with `"name": "@aggregator-dpg/<name>"`.
2. Add `build`, `test`, `lint`, `typecheck` scripts.
3. Run `pnpm install` — turbo picks it up automatically.
4. No changes needed to root config.

## Commit style

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

```
feat(scope): short imperative description
fix(scope): short imperative description
chore(scope): ...
```

Task commits must include the sub-issue number:

```
#189 feat(T-01.1.1): init pnpm and pnpm-workspace.yaml
```

Do **not** bypass pre-commit hooks with `--no-verify`.

## Pre-commit hooks

Every commit runs `lint-staged` automatically via husky:

| Staged files                         | Action                                |
| ------------------------------------ | ------------------------------------- |
| `*.{ts,tsx,js,mjs,cjs,json,yaml,md}` | `prettier --write` (auto-format)      |
| `*.{ts,tsx}`                         | `eslint --fix` (auto-fix lint errors) |

Hooks run on staged files only — they are fast and non-blocking for unrelated changes.

**Never use `--no-verify` to skip hooks.** If the hook fails:

1. Read the error — it tells you exactly what is wrong.
2. Fix the issue (`eslint` errors that cannot be auto-fixed require manual correction).
3. Re-stage the fixed file and commit again.

Skipping hooks lets broken or unformatted code into the history and breaks the shared style baseline for the entire team.
