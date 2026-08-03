# Aggregator DPG — Local Setup

End-to-end guide for running the Aggregator Portal + API on a fresh machine. The product spec lives in [`README.md`](README.md); this file is the operational quickstart.

---

## 1. Prerequisites

| Tool                    | Version | Notes                                                                        |
| ----------------------- | ------- | ---------------------------------------------------------------------------- |
| Node.js                 | 22 LTS  | The repo's `engines` field asks for `>=24` but 22 works for dev (CI runs 24) |
| pnpm                    | 10.x    | `npm i -g pnpm`                                                              |
| Docker + Docker Compose | recent  | For Postgres, Keycloak, Redis, Mailpit                                       |
| AWS CLI + S3 bucket     | latest  | Object storage (CSV uploads, QR PNGs, errors.csv). IAM role on the VM.       |
| `openssl`               | any     | Generating session + approval-token secrets                                  |

Optional but recommended:

- A Mac/Linux shell, or native Windows (Docker Desktop). On Windows use the `pnpm stack:*` scripts (`make` not required) — see QUICKSTART.md §3 "Windows note". WSL2 also works.
- A REST client (Postman, curl, HTTPie) for poking the API directly.

---

## 2. Clone and install

```bash
git clone <repo-url> aggregator-dpg
cd aggregator-dpg
pnpm install
```

This installs every workspace under `apps/*` and `packages/*` in one shot.

---

## 3. Bootstrap the local stack

There are two supported run modes:

| Mode                             | Use when                                                     | Sections to follow |
| -------------------------------- | ------------------------------------------------------------ | ------------------ |
| **Hybrid (dev)**                 | Active development with hot-reload of API/web outside docker | §3 → §9            |
| **Docker-only (prod-like / VM)** | Running everything (api + web + foundations) in containers   | §3 → §3a → §6 → §8 |

For docker-only deploys (single VM, staging, prod), see **§3a** below. For local dev with hot-reload, continue with §3.

A single Docker Compose file brings up every backing service. The first run pulls images (~1.5 GB) and starts:

| Service  | Host port                  | Purpose                                                          |
| -------- | -------------------------- | ---------------------------------------------------------------- |
| Postgres | `5433` → 5432              | Aggregator DB (5433 leaves system Postgres on 5432 untouched)    |
| Keycloak | `8080`                     | OIDC, OTP authenticator, admin REST API                          |
| Redis    | `6379`                     | BFF session store, future BullMQ queues                          |
| Mailpit  | `1025` (SMTP), `8025` (UI) | Local SMTP catch-all — open <http://localhost:8025> to read mail |

Object storage (S3) is **not** in compose. The api + worker talk to AWS S3
directly via the regional endpoint and IAM-role credentials. On the VM, the
EC2 instance profile must grant `s3:{Get,Put,Head,Delete}Object` on
`arn:aws:s3:::${S3_BUCKET}/*` and `s3:ListBucket` on the bucket. Locally,
the SDK picks up creds from `~/.aws/credentials` (run `aws configure`).

Compose needs a couple of secrets injected via the **root** `.env`:

```bash
cp .env.example .env

# Minimum required values (populate the rest only if you want real SMTP)
SESSION_KEY=$(openssl rand -hex 32)
KEYCLOAK_CLIENT_SECRET=change-me   # any value; KC will accept it on first import
```

Then bring everything up:

```bash
docker compose up -d
docker compose ps   # wait until aggregator-keycloak is "healthy"
```

The Keycloak realm is auto-imported from `infra/keycloak/realms/aggregator-realm.json` on container start. The custom OTP authenticator SPI is bundled at `infra/keycloak/providers/keycloak-otp-1.0.0-SNAPSHOT.jar` and mounted into `/opt/keycloak/providers/` by Compose, so login-by-OTP works out of the box. The JAR is committed to the repo to keep first-time setup zero-friction; rebuild it from <https://github.com/sanketika-labs/keycloak-otp-authenticator> when you bump the version.

---

## 3a. Docker-only run (web + api in containers)

Use this when deploying to a VM, staging, or any host where you want everything in containers (no `pnpm dev`). All env values live in a **single root `.env`** sectioned per service.

### One-shot setup

```bash
make setup        # copies infra/env.template → .env (mode 600) AND adds `127.0.0.1 keycloak` to /etc/hosts
# edit .env — fill every change-me-* and generate secrets:
#   SESSION_KEY=$(openssl rand -hex 32)
#   APPROVAL_TOKEN_SECRET=$(openssl rand -hex 32)
make up           # docker compose up -d --build
```

> **Cross-platform / Windows:** every `make <target>` for the local stack has a `pnpm stack:<target>` equivalent (`setup`, `up`, `down`, `reset`, `logs`, `ps`, `psql`, `rebuild-web`), both driven by `scripts/stack.mjs`. On native Windows (no WSL2) use the pnpm form; `make` is not required. See QUICKSTART.md §3 "Windows note".

### Why `/etc/hosts` needs `127.0.0.1 keycloak`

When the web container is inside docker, browser and web container must resolve the OIDC issuer URL to the SAME Keycloak. With `OIDC_ISSUER=http://keycloak:8080/...`:

- Browser: `keycloak` → `127.0.0.1` (via /etc/hosts) → docker port `8080` → keycloak container ✓
- Web container: `keycloak` → docker DNS → keycloak container ✓

Both sides agree, JWT issuer claim validates. Without the hosts entry, browser cannot resolve `keycloak` and OIDC redirect fails.

`make setup` (or `pnpm stack:setup`) is idempotent — safe to re-run; it never duplicates host entries.

### `.env` structure

The template at `infra/env.template` is sectioned per service with config + secrets subsections:

```
# ════════════ postgres ════════════
# --- config ---
POSTGRES_USER=...
# --- secrets ---
POSTGRES_PASSWORD=...

# ════════════ api ════════════
# --- config ---
LOG_LEVEL=info
# --- secrets ---
APPROVAL_TOKEN_SECRET=...
```

Same structure ports cleanly to Kubernetes later (config block → ConfigMap, secrets block → Secret).

### VM deploy

When moving from localhost to a VM, replace `localhost` and `keycloak` everywhere in `.env` with the VM hostname/IP, then:

```bash
docker compose up -d --build   # --build is REQUIRED — NEXT_PUBLIC_API_URL is baked at compile time
```

Also update Keycloak realm client `aggregator-portal` → **Valid Redirect URIs** + **Web Origins** to match the new portal URL.

---

## 4. App-specific environment files

Two apps run outside Compose during development:

```bash
# Aggregator API (Fastify, port 4000)
cp apps/api/.env.example apps/api/.env

# Aggregator Web BFF (Next.js, port 3000)
cp apps/web/.env.example apps/web/.env
```

### apps/api/.env — required edits

```dotenv
# Approval JWT signing key — must be ≥ 32 chars
APPROVAL_TOKEN_SECRET=<openssl rand -hex 32>

# Real SMTP (skip for local dev — MailHog defaults work)
# MAIL_PROVIDER=smtp
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_FROM=ops@yourorg.in
# SMTP_USER=ops@yourorg.in
# SMTP_PASSWORD=<gmail-app-password>
# ADMIN_EMAILS=admin@yourorg.in
```

- `SUPPORT_EMAIL` — recipient for the portal "Contact support" form (Sidebar). Unset ⇒ the button is hidden and the endpoint returns 503. Uses the same mailer as registration emails; Reply-To is the submitting coordinator. Locally, mail lands in Mailpit (`:8025`).

The realm import does **not** carry literal client secrets — `render-realm.sh` substitutes them from `KEYCLOAK_ADMIN_CLIENT_SECRET` (→ `aggregator-api`), `OIDC_CLIENT_SECRET` (→ `aggregator-portal`), and `BFF_SERVICE_CLIENT_SECRET` (→ `aggregator-bff`) at Keycloak boot, and fails hard if any is unset. Choose the secrets yourself; the app-side value must equal the value Keycloak rendered. The BFF uses the dedicated minimal-scope `aggregator-bff` client — **never** the `aggregator-api` client (which holds realm-management).

### apps/web/.env — required edits

```dotenv
SESSION_KEY=<openssl rand -hex 32>          # different value from the API one
OIDC_CLIENT_SECRET=<aggregator-portal secret — same value Keycloak rendered>
BFF_SERVICE_CLIENT_ID=aggregator-bff
BFF_SERVICE_CLIENT_SECRET=<aggregator-bff secret — same value Keycloak rendered>
```

How to read the Keycloak client secrets the first time:

1. Open <http://localhost:8080/admin> (admin / `admin` per the Compose file).
2. Switch to the `aggregator` realm (top-left dropdown).
3. **Clients → `aggregator-portal` → Credentials** → copy "Client secret" → paste into `apps/web/.env` as `OIDC_CLIENT_SECRET`.
4. **Clients → `aggregator-api` → Credentials** → copy "Client secret" → paste into `apps/api/.env` → `KEYCLOAK_ADMIN_CLIENT_SECRET`.
5. **Clients → `aggregator-bff` → Credentials** → copy "Client secret" → paste into `apps/web/.env` → `BFF_SERVICE_CLIENT_SECRET`.

---

## 5. Keycloak realm — one-time mappers

The realm import covers most settings. Two protocol mappers must be added by hand so access tokens carry the claims our API verifies.

**Clients → `aggregator-portal` → Client scopes → `aggregator-portal-dedicated` → Add mapper → By configuration → User Attribute**

| Field               | Value           |
| ------------------- | --------------- |
| Name                | `aggregator_id` |
| User Attribute      | `aggregator_id` |
| Token Claim Name    | `aggregator_id` |
| Claim JSON Type     | String          |
| Add to ID token     | ON              |
| Add to access token | ON              |
| Add to userinfo     | ON              |
| Multivalued         | OFF             |

Repeat the steps for the `phoneNumber` attribute (token claim name `phone_number`). Without these mappers the profile endpoint returns `403 MISSING_AGGREGATOR_ID`.

---

## 6. Database migrations

```bash
pnpm --filter @aggregator-dpg/api db:migrate
```

This applies `apps/api/drizzle/migrations/0000_init.sql`, creating the two tables in the `aggregator-dpg` database:

- `aggregators` (id, org_slug, type, created_at, updated_at)
- `aggregator_profiles` (aggregator_id FK CASCADE, schema_version, data, consent, created_by, updated_by, created_at, updated_at)

Verify:

```bash
docker exec aggregator-postgres psql -U aggregator -d aggregator -c '\dt'
```

---

## 7. Run the apps

Two terminals:

```bash
# Terminal 1 — Fastify API on :4000
pnpm --filter @aggregator-dpg/api dev

# Terminal 2 — Next.js portal + BFF on :3000
pnpm --filter @aggregator-dpg/web dev
```

Health checks:

```bash
curl -s http://localhost:4000/health/live    # {"status":"ok"}
curl -s http://localhost:3000                 # 200 (login page)
```

---

## 8. Smoke test the registration flow

```text
1.  Visit http://localhost:3000/register
2.  Fill the 4-field form (type, organisation, email, phone) and submit
3.  Open http://localhost:8025 — admin email lands there with Approve / Reject links
4.  Click "Approve" → confirmation page → Approve button → applicant gets a welcome email
5.  Visit http://localhost:3000/login → sign in with the registered email or phone (OTP)
6.  Keycloak prompts for first/last name (UPDATE_PROFILE required action)
7.  After fill, you land on the Blue Dots portal. Profile page shows the data.
```

> **If you previously ran the stack (before this commit):** the realm import used to
> ship two seed users (`testuser@example.com` / `+919876543210` and
> `alice@example.com` / `+919812345678`) that are now removed. They may still live
> in your Keycloak DB from a prior boot — register with a different phone/email,
> or wipe the volume once with `docker compose down -v && make up`.

---

## 9. Common workspace commands

```bash
# Run all tests across the monorepo
pnpm -w test

# Per-app
pnpm --filter @aggregator-dpg/api test
pnpm --filter @aggregator-dpg/web test

# Coverage
pnpm --filter @aggregator-dpg/api test:coverage

# Lint + typecheck (everything)
pnpm -w lint
pnpm -w typecheck

# Generate a new Drizzle migration after editing schema.ts
pnpm --filter @aggregator-dpg/api db:generate

# Apply migrations
pnpm --filter @aggregator-dpg/api db:migrate
```

---

## 10. Project layout (registration-flow scope)

```
apps/
  api/                     Fastify backend
    drizzle/migrations/    Drizzle SQL migrations (one per schema bump)
    src/
      app.ts               Fastify wiring (cors, formbody, sensible)
      server.ts            Process entrypoint (loads env via env.ts)
      env.ts               Loads apps/api/.env early
      config.ts            Zod-validated env config
      db/
        schema.ts          Drizzle table definitions
        client.ts          pg.Pool + Drizzle singleton
        migrate.ts         Migration runner
      routes/
        aggregator-registrations.ts   POST /v1/aggregator-registrations/create
        aggregator-approvals.ts       Admin-side review pages + decision POST
        aggregator-profile.ts         GET/PUT /v1/aggregators/profile/me
        health.ts
      services/
        aggregator-store/             Postgres + in-memory + fake (per the rules)
        aggregator-profile-store/     Same shape as aggregator-store
        idp-admin/                    Keycloak admin REST adapter
        mailer/                       SMTP / SES / Fake
        email-templates/              Inline HTML email shells
        approval-token.ts             Sign / verify approval JWT (HS256)
        registration-validator.ts     Ajv 2020 compile of registration.v1.json
        profile-validator.ts          Ajv 2020 compile of profile.v1.json
        slug.ts                       slugify + random suffix
        phone.ts                      E.164 normalisation
        auth/access-token.ts          KC JWKS verify (user + service tokens)
      views/
        approval-pages.ts             Server-rendered HTML for admin flow
  web/                     Next.js BFF + portal
    src/
      app/
        api/auth/                     OIDC login / callback / logout / me
        api/aggregator/register       Anonymous registration proxy (service token)
        api/aggregator/profile/me     GET/PUT proxy (user token via callApi)
        (public)/login                Login page
        (public)/register             Registration form (RJSF)
        (protected)/profile/complete  First-login profile completion form (RJSF)
        (protected)/profile           Active profile view
      lib/
        oidc/                         OIDC client + adapter
        session/                      Memory + Redis session stores
        upstream-client.ts            User-token attached fetch (callApi)
        service-token.ts              Service-account token cache (BFF → backend)
        cookies.ts                    Signed flow cookie + session cookie helpers
config/
  schemas/aggregator/
    registration.v1.json   4-field pre-approval schema
    registration.v1.ui.json
    profile.v1.json        Post-login profile completion schema
    profile.v1.ui.json
infra/
  keycloak/realms/aggregator-realm.json   Realm import (clients, roles, OTP authenticator)
docker-compose.yml         All backing services
```

---

## 11. Troubleshooting

| Symptom                                                         | Likely cause                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EADDRINUSE 0.0.0.0:4000`                                       | Old API still running. `lsof -ti:4000 \| xargs kill -9`                                                                                                                                                                  |
| `KEYCLOAK_URL ... must be set`                                  | API started without picking up `apps/api/.env` — run `pnpm --filter @aggregator-dpg/api dev` from the repo root, not from `apps/api/`                                                                                    |
| BFF: `service-token HTTP 401: invalid client credentials`       | `BFF_SERVICE_CLIENT_SECRET` mismatch with `aggregator-api` client secret in KC                                                                                                                                           |
| `403 MISSING_AGGREGATOR_ID` from `/v1/aggregators/profile/me`   | KC protocol mapper for `aggregator_id` not configured (see §5)                                                                                                                                                           |
| `409 PHONE_EXISTS` on registration                              | Phone already used by another KC user (unique check is intentional — same phone can't OTP-route to two accounts)                                                                                                         |
| Approval link page shows "Already approved" on first click      | Test data left over — KC user has `decision_made=approved` attribute. Delete the user in KC admin or pick a different aggregator id                                                                                      |
| Login complains "user does not exist" with the registered email | KC user's email field is empty. Either (a) re-register so the new createUser path populates email + emailVerified, or (b) edit the user in KC admin                                                                      |
| Submit returns 201 but no email arrives                         | `apps/api/.env` still points at MailHog. Check <http://localhost:8025> for captured mail or switch `MAIL_PROVIDER=smtp` to a real provider                                                                               |
| Login redirects to `/login?error=invalid_flow_cookie`           | `COOKIE_SECURE` is `true` (or unset, defaulting to `true` under `NODE_ENV=production`) but the portal is served over plain HTTP. Set `COOKIE_SECURE=false` in `.env` and run `docker compose up -d --force-recreate web` |

---

## 12. Where things live (further reading)

- Architecture document: `docs/aggregator-app-technical-design.md` (or whichever filename your fork uses) — covers the spec across all four functional layers.
- Coding rules: `.claude/rules/*.md` — base-class pattern, interfaces, error handling, logging, testing, configuration discipline.
- Realm export: `infra/keycloak/realms/aggregator-realm.json` — clients (`aggregator-portal`, `aggregator-api`), roles, OTP authenticator config.
- Config schemas: `config/schemas/aggregator/*.json` — single source of truth for forms, API validation, and (in future) bulk-upload validation.

---

## 13. Reset everything

```bash
# Stop containers, drop volumes
docker compose down -v

# Wipe drizzle migrations metadata in the new DB if you re-run migrate
docker exec aggregator-postgres psql -U aggregator -d aggregator -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;'

# Re-up + migrate
docker compose up -d
pnpm --filter @aggregator-dpg/api db:migrate
```
