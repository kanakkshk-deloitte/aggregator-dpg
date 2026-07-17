# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

Aggregator DPG — the Aggregator-facing app of the Blue Dots / Signal Stack ecosystem. pnpm + Turbo monorepo, TypeScript-only. See `README.md` for the product spec and `SETUP.md` for the local-stack walkthrough.

## Toolchain

- **Node** ≥ 24 (CI pins Node 24; Node 22 works locally).
- **pnpm** ≥ 10 — `corepack enable pnpm` or `npm i -g pnpm`. Required (other PMs are not supported).
- **Turbo** orchestrates `build`, `test`, `lint`, `typecheck`, `dev` topologically.
- **Docker + Compose** brings up Postgres (`:5433`), Keycloak (`:8080`), Redis (`:6379`), Mailpit (`:8025`).
- **AWS S3** is **not** in compose — the API and worker hit real S3 via IAM role / `~/.aws/credentials`.

## Common commands

```bash
# Whole-repo
pnpm -w build            # turbo run build (cached, topological)
pnpm -w test             # all package tests (vitest)
pnpm -w lint             # eslint everywhere
pnpm -w typecheck        # tsc --noEmit everywhere
pnpm dep-check           # dep-cruiser: enforces interface-boundary rules (see below)

# Per package / app
pnpm --filter @aggregator-dpg/api dev          # Fastify API on :4000 (tsx watch)
pnpm --filter @aggregator-dpg/web dev          # Next.js portal + BFF on :3000
pnpm --filter @aggregator-dpg/worker dev       # BullMQ worker (tsx watch)
pnpm --filter <pkg> test                       # one package's vitest
pnpm --filter <pkg> test --coverage            # with coverage (≥ 70% line target)
pnpm --filter <pkg> test -- path/to/file.test.ts   # single test file
pnpm --filter <pkg> test -- -t "test name"         # single test by name

# DB (Drizzle, owned by apps/api)
pnpm --filter @aggregator-dpg/api db:generate  # generate new migration after editing schema
pnpm --filter @aggregator-dpg/api db:migrate   # apply migrations
pnpm --filter @aggregator-dpg/api db:studio    # Drizzle Studio

# Local stack
# Cross-platform entrypoint (Windows-friendly; make not required):
pnpm stack:setup        # = make setup  (env + hosts via scripts/stack.mjs)
pnpm stack:up           # = make up
# stack:down | stack:reset | stack:logs | stack:ps | stack:psql | stack:rebuild-web
make setup    # one-shot: copies infra/env.template -> .env (chmod 600) + adds 127.0.0.1 keycloak to /etc/hosts
make up       # docker compose up -d --build (everything containerised)
make down     # stop containers (volumes preserved)
make reset    # docker compose down -v — DESTROYS data volumes
make psql     # psql into local postgres
make rebuild-web         # rebuild web image + restart container (use after NEXT_PUBLIC_* env change)
make rebuild-keycloak    # rebuild OTP SPI jar + restart Keycloak
```

Commits run husky/lint-staged (`prettier --write` + `eslint --fix`) on staged files. Conventional Commits required; **do not bypass with `--no-verify`** (per `CONTRIBUTING.md`).

## Architecture

### Three deployable apps (`apps/`)

- **`api`** — Fastify BFF on `:4000`. Owns the Aggregator DB (Drizzle + Postgres), Keycloak admin integration, registration/approval flow, bulk-upload entry point, registration links, profile endpoints. Reads upstream Signal Stack (UBI backend) and Jobs Stack; in MVP it has **no write access** to Signal Stack except via the bulk-create paths. Every handler asserts `session.aggregator_id`; `aggregator_id` is **never** trusted from the client. Registration is an in-app **token-based email-approval** flow (signed approval-token links → approver page → atomic CAS on the row → Keycloak user enable/role assign), with expired-link regenerate, resubmit-reclaim, and a service-auth stale-registration prune endpoint. Registration also records an append-only **consent ledger** row (fail-closed: no subject is provisioned without a consent record). An optional **org → coordinator hierarchy** (parent org owns many coordinators) sits behind the `ORG_HIERARCHY_ENABLED` flag — see below. Also exposes **contact-support** endpoints (`GET /v1/support/config`, `POST /v1/support`, both authenticated) gated by the per-instance **`SUPPORT_EMAIL`** env: unset ⇒ config reports `enabled:false` and `POST` returns `503 SUPPORT_NOT_CONFIGURED`; set ⇒ the submission is emailed via the aggregator's own mailer (`getMailer()`) with Reply-To = the submitting coordinator (a failed send is `502 SUPPORT_SEND_FAILED`).
- **`web`** — Next.js 15 (App Router) portal + its own BFF. Anonymous flows hit the backend with a service-account token (`service-token.ts`); authenticated flows attach the user OIDC token via `callApi` (`upstream-client.ts`). Sessions are signed cookies backed by Redis (`lib/session/`). Forms are RJSF-driven from `config/schemas/aggregator/*.json` so non-engineers can evolve the profile/registration forms without code changes. Registration renders coordinator + (flag-gated) organisation tabs, with a required consent checkbox and a read-only Terms/Privacy popup (`components/consent/`) whose Markdown content is loaded from `config/**/consent.json`. The `/profile` page renders that **same** `registration.v1` schema **read-only** (single source via `lib/aggregator-schema.server.ts`, every field disabled) with a stubbed "Request an update" panel over the `x-updatable` fields — never an editable profile form. The Sidebar's "Contact support" entry appears only when the API reports `SUPPORT_EMAIL` configured (`GET /v1/support/config`, surfaced via `supportEnabled` on `auth-context`).
- **`worker`** — BullMQ jobs (`bulk-file-process`, `bulk-row-process`, `bulk-finalise`, `cron-watchdog`, `link-metrics-rollup`). Consumes the same DB schema + S3 + signalstack-writer. Crontab-style jobs are watchdogged. Bulk CSV parsing is **streamed** (`bulk-file-stream`) to bound memory on large files. A process runs every consumer role by default; set `WORKER_ROLES` (comma-separated subset of `file,row,finalise,cron`, or `all`) to split roles across pods — e.g. run the CPU-heavy `file` parser in its own deployment. The union of roles across the fleet must cover all four or uploads strand.

### Shared packages (`packages/`)

All cross-package consumption goes through **subpath exports** declared in each `package.json`. Common pattern: every service package exports `./interface` (abstract class + Zod schemas), one or more concrete impls (`./postgres`, `./http`, `./memory`), and `./testing` (in-memory fake + `buildX()` helpers). Apps and other packages import from `./interface` and `./testing` only.

- **`shared-primitives`** — `Result<T, E>` (`ok` / `err` / `match`), typed error hierarchy (`BaseError` → `UpstreamError`, `ConfigError`, `AuthError`, `ValidationError`, `DomainError`), branded IDs, shared DTOs (`Filter`, `Paginated<T>`, `Timestamps`), Beckn primitives, aggregator-specific DTOs.
- **`db-schema`** — Drizzle table definitions and inferred types. The single source of truth for the schema; apps import tables from here.
- **`participants-writer`**, **`signalstack-writer`** — abstract base + Postgres/HTTP impl + in-memory fake. Writers that the API and worker share. `signalstack-writer` also exposes `fetchDecryptedProfiles` (backs the server-side profile-data CSV export).
- **`consent-ledger`** — append-only registration-consent store. Abstract `ConsentLedgerBase` (`./interface`) + `./postgres` / `./memory` / `./testing`; one method, `recordRegistrationConsent`, writes a polymorphic (`org` | `aggregator`) row and never throws (`Result<T, BaseError>`).
- **`queue`** — BullMQ wiring (queue names, types, connection helpers).
- **`schema-loader`** / **`config-loader`** / **`schema-service`** — config-as-code loaders. Domain/env-specific values come from `config/*.yaml` and `config/schemas/`, **never** hardcoded. `config-loader` also exposes a `./consent` subpath that loads + validates per-audience (`org` / `aggregator`) versioned consent content (`consent.json`), resolved by `AGGREGATOR_NETWORK` / `AGGREGATOR_BRAND` with brand override merge. The consent loader renders the `__SUPPORT_EMAIL__` placeholder in that content to `CONSENT_SUPPORT_EMAIL` (default `hello@bluedotseconomy.org`) at load, so the T&C/Privacy/Grievances contact is deploy-time configurable without editing consent content (#266) — distinct from `SUPPORT_EMAIL` (the contact-form recipient).
- **`tsconfig`** — `base.json`, `node.json`, `next.json` extends-targets.
- **`_template`** — copy-paste scaffold for a new service package (interface + memory + testing).

### Identity / OIDC

Keycloak realm `aggregator` (imported on first boot from `infra/keycloak/realms/aggregator-realm.json`). Two clients: `aggregator-portal` (web, public, OIDC code flow) and `aggregator-api` (API + BFF service account, confidential). The `aggregator-api` service account holds `realm-management` roles `manage-users` (user CRUD + role mapping) **and** `manage-realm` (group create/manage for the org hierarchy). The realm ships an `org_owner` realm role (present even when `ORG_HIERARCHY_ENABLED=false`); it is assigned to a parent-org owner at org approval. A custom OTP-by-email/phone authenticator SPI is bundled at `infra/keycloak/providers/keycloak-otp-1.0.0-SNAPSHOT.jar` and rebuilt from <https://github.com/sanketika-labs/keycloak-otp-authenticator>. A post-import init script (`infra/keycloak/init/apply-user-profile.sh`) enables unmanaged attributes + applies SMTP config. Two protocol mappers (`aggregator_id`, `phone_number` user attributes → token claims) **must be added by hand** after a fresh import — see `SETUP.md` §5; without them the profile endpoint returns `403 MISSING_AGGREGATOR_ID`.

### Org → coordinator hierarchy (`ORG_HIERARCHY_ENABLED`)

Per-instance feature flag (default **off**), read once at startup by **both** the API and the web app — set it identically on both (env + `docker-compose.yml`). **Off:** today's flat registration/approval flow is unchanged — no org tab, no org dropdown, `aggregators.parent_org_id` stays null, and the org routes are not registered (404); the migrations are additive/inert. **On:** the API exposes `/v1/orgs*` (create/list) and `/admin/v1/orgs*` (approval) routes, a parent org is its own registration+approval flow (system-of-record table `aggregator_orgs`, mirrored Keycloak group, disabled org-owner user enabled + granted `org_owner` at approval), and coordinator registration then requires a valid active `org_id` that is stamped onto `aggregators.parent_org_id` with the approval email routed to the org owner. The token↔`parent_org_id` binding is enforced on the coordinator decision path regardless of the runtime flag (data-level security invariant).

### Local stack run modes

- **Hybrid (dev)** — `docker compose up -d` for backing services + `pnpm --filter ... dev` for api/web/worker outside the container. Uses `apps/<app>/.env` (copy from `.env.example`).
- **Docker-only (VM / prod-like)** — `make setup && make up`. All env values live in a **single root `.env`** sectioned per service (`infra/env.template` is the canonical layout). `NEXT_PUBLIC_API_URL` is baked at compile time, so VM redeploys must use `docker compose up -d --build`.
- **Unified full-ecosystem stack (`local-setup/`)** — brings up **both** aggregator-dpg _and_ the upstream signals-dpg (+ shared Postgres/Redis/Keycloak/MinIO/Mailpit) in one `docker compose up -d`, wired for localhost. It builds both repos, so it expects `aggregator-dpg` and `signals-dpg` checked out as **siblings** and is run from `local-setup/`. See `local-setup/LOCAL_SETUP.md` for the full walkthrough (Track A = all-in-Docker, Track B = hybrid). The compose here (repo root `docker-compose.yml`) remains the VM/prod nginx+certbot ingress variant.

When deploying to a VM, replace `localhost` and `keycloak` everywhere in `.env` with the VM hostname/IP, and update the `aggregator-portal` client's **Valid Redirect URIs** + **Web Origins** in the Keycloak admin console.

## Nested docs

Auto-loaded when working inside their subtree — read the relevant one before making changes there: `apps/api/CLAUDE.md` (per-file auth-wrapper pattern, registration status state machine, consent-ledger rollback contract, the Keycloak retry gap, org-hierarchy flag mechanics, bulk-upload API/worker boundary), `apps/web/CLAUDE.md` (anonymous-vs-authenticated helper invariant, session/auth-context, the dual-mode registration/profile schema rendering, consent content flow), `apps/worker/CLAUDE.md` (the `WORKER_ROLES` per-process-only coverage check, the `link-metrics-rollup.ts` double-count risk), `packages/queue/README.md` (the atomic Lua row-commit script).

## Project rules (`.claude/rules/`)

Non-negotiable for any code change. Some load always; some are path-scoped and only enter context when you touch a matching file (frontmatter `paths:` — see each file):

- **`error-handling.md`**, **`logging-observability.md`**, **`configuration-discipline.md`**, **`code-documentation.md`** — **always loaded**, genuinely repo-wide (external-call timeouts/retry/typed errors; structured pino logging; no hardcoded domain/env values; TSDoc on every public API).
- **`base-class-pattern.md`** + **`interfaces.md`** — **path-scoped** to `packages/*/src/**`, `apps/api/src/services/**`, `apps/web/src/lib/{oidc,session}/**` (the only places this repo authors an `interface.ts`-style abstract-class contract — `apps/worker` never does). Every cross-package contract is an `abstract class` (NOT a TS `interface`), schema/DTO naming (`<Entity>Schema`, `Create<Entity>Input`, etc.), `Result<T, BaseError>` returns, never throw across a service boundary.
- **`testing.md`** — **path-scoped** to `packages/*/src/testing.ts`, `packages/*/src/testing/**`, `apps/api/src/services/**` (wherever the `./testing` fake-subpath convention actually lives). Fakes over `vi.mock()`, extend the in-memory impl, `seed()` + `build<Entity>()` helpers.
- **`testing-requirements.md`** — **path-scoped** to any test file (`**/*.test.ts(x)`, `**/*.integration.test.ts`, `**/__tests__/**`) — applies repo-wide including `apps/web`/`apps/worker` tests that don't use the fake-subpath convention. Vitest only, ≥70% line coverage, `.integration.test.ts` excluded from `pnpm -w test`.

The dep-cruiser config (`.dependency-cruiser.cjs`) enforces these at CI time:

1. `no-cross-service-impl-imports` — cross-package imports must go through `./interface` or `./testing` subpaths.
2. `no-heavy-deps-in-interface` — interface files may only import `shared-primitives`, `zod`, or `node:*`.

Run `pnpm dep-check` locally before pushing; it's a required CI step.

## CI

GitHub Actions `CI` job runs on every PR to `main` / `v0.*`: `pnpm -w lint`, `typecheck`, `test`, `build`, then `pnpm dep-check`. A separate `docker / {api,web,worker}` matrix builds and (on non-PR pushes) publishes to GHCR. Branch protection requires the `CI` check (see `docs/ci-required-checks.md`). Tags `web-v*`, `api-v*`, `worker-v*` cut release images per app.
