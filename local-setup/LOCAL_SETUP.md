# Local Setup Guide — Blue Dots / Signal Stack

A single, self-contained guide for bringing up **both** projects on a fresh
machine. Written for a new engineer who wants working services fast, and for a
developer who wants hot-reload while writing code.

- **`signals-dpg/`** — the **DPG / "Signals Stack"**: a network-aware backend that
  publishes, validates, discovers, and interacts with schema-typed _items_
  across instances. Source of truth for orgs, members, and profiles.
- **`aggregator-dpg/`** — the **Aggregator portal**: a read-and-orchestrate
  surface (web portal + API + background worker) that sits _downstream_ of
  signals-dpg and calls it as an upstream service.

They are two independent git repos. This unified tooling
(`docker-compose.yml`, `.env.example`, and the `infra/` helpers) lives **inside
the aggregator-dpg repo at `aggregator-dpg/local-setup/`** and builds both DPGs.

> **📁 Required layout.** Because the compose builds _both_ repos, it expects
> them checked out as **siblings** under a common parent directory, and you run
> everything from `aggregator-dpg/local-setup/`:
>
> ```
> <parent>/
>   ├── aggregator-dpg/          (this repo)
>   │     └── local-setup/       ← you are here; run `docker compose` from HERE
>   └── signals-dpg/             (sibling; built via ../../signals-dpg)
> ```
>
> Throughout this guide, **"from `local-setup/`"** means
> `cd <parent>/aggregator-dpg/local-setup` first.

---

## 0. Which track are you?

| Track               | You want to…                                                       | Follow                 |
| ------------------- | ------------------------------------------------------------------ | ---------------------- |
| **A — Docker-only** | Just get everything running to explore/demo the apps. One command. | §1 → §2 → §3 → §5      |
| **B — Hybrid dev**  | Write code with hot-reload; both DPGs run from source.             | §1 → §6 (3 steps) → §3 |

Both tracks share the same prerequisites (§1). Track A uses the unified
`docker-compose.yml` in this `local-setup/` directory. Track B runs each app
with `pnpm dev` against Dockerised backing services, using each repo's own
tooling.

> **⚠️ Memory guidance.** Track A builds **5 app images** and then runs **~11
> containers** — budget **≥ 6 GB of Docker memory** (Docker Desktop → Settings →
> Resources → Memory) and ideally a 16 GB machine. On an **8 GB machine** (where
> Docker can only get ~4 GB), Track A will OOM-thrash — a first
> `docker compose up --build` can take an hour or fail. **Use Track B instead:**
> Docker then only runs small _prebuilt_ backing images (no builds), and the
> Node apps run on the host, so nothing has to fit the whole stack into the
> Docker VM. See §6.
>
> **Alternative — build one image at a time (if you must stay on Track A).** A
> single `docker compose up --build` builds all app images in parallel, which is
> what exhausts memory. Build them **sequentially** first, so only one build runs
> at a time (far lower peak memory) and a failure stops immediately on the
> offending service instead of after a long parallel run:
>
> ```bash
> # macOS / Linux / Git Bash / WSL — from aggregator-dpg/local-setup/
> # build images one by one, stop on first failure
> for s in signals-bootstrap signals-api signals-ui aggregator-api aggregator-worker aggregator-web; do
>   docker compose build "$s" || { echo "FAILED at $s"; break; }
> done
> ```
>
> ```powershell
> # Windows PowerShell — from aggregator-dpg\local-setup\ (the bash loop above
> # is NOT valid PowerShell: ||, for..do..done, and $s all differ)
> foreach ($s in "signals-bootstrap","signals-api","signals-ui","aggregator-api","aggregator-worker","aggregator-web") {
>   docker compose build $s
>   if ($LASTEXITCODE -ne 0) { Write-Host "FAILED at $s"; break }
> }
> ```
>
> Once all images are built, start the stack **without** rebuilding:
> `docker compose up -d` (no `--build`). If a build still OOMs on a single
> service, close other apps or raise the Docker memory limit, then re-run the
> loop — already-built images are cached, so it resumes at the failed service.

---

## 1. Prerequisites

### 1.1 Software

| Tool                                    | Version                              | Needed for                      | Notes                                                             |
| --------------------------------------- | ------------------------------------ | ------------------------------- | ----------------------------------------------------------------- |
| **Docker + Docker Compose**             | recent (v2)                          | both tracks                     | Docker Desktop on macOS/Windows; engine + compose plugin on Linux |
| **Node.js**                             | ≥ 24 (22 works for dev)              | Track B; Track A never needs it | CI pins 24                                                        |
| **pnpm**                                | 10.x (aggregator) / 11.1.2 (signals) | Track B                         | `npm i -g pnpm` or `corepack enable pnpm`                         |
| **openssl**                             | any                                  | generating secrets              | pre-shipped on macOS/Linux                                        |
| **git**                                 | any                                  | cloning                         | —                                                                 |
| A REST client (curl / Postman / HTTPie) | —                                    | poking APIs, cross-DPG wiring   | optional                                                          |

You do **not** need a real AWS account, a real SMTP server, or a real SMS
gateway for local setup — the unified stack substitutes MinIO (for S3), Mailpit
(for email), and Keycloak's `log` SMS provider (OTP codes print to logs).

### 1.2 Functional prerequisites (things that aren't software)

These are the human/config inputs the apps expect. The unified `.env.example`
pre-fills everything except the first item.

| Prerequisite                                                                                       | Why it's needed                                                                                                                        | Local default                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Admin email address** (`ADMIN_EMAILS`)                                                           | aggregator-dpg emails new-aggregator **approval requests** here. You approve/reject from this inbox to complete the registration flow. | You must set it. Any address works — the mail is captured by Mailpit, not actually delivered.                                              |
| **SMTP account**                                                                                   | Sending real approval + OTP email in staging/prod.                                                                                     | Not needed locally (Mailpit catches all). For real email use a Gmail **App Password** (not your login password) or Amazon SES.             |
| **SMS / OTP provider**                                                                             | Delivering login OTPs by phone in prod (Twilio / AWS SNS / MSG91).                                                                     | Not needed locally — Keycloak's `log` provider writes the code to `docker compose logs keycloak`; signals-dpg sets `CREATE_TEST_OTP=true`. |
| **S3 bucket + credentials**                                                                        | aggregator bulk-uploads, QR PNGs, error CSVs in prod.                                                                                  | Not needed locally — MinIO provides an S3-compatible endpoint and the bucket is auto-created.                                              |
| **App secrets** (`SESSION_KEY`, `APPROVAL_TOKEN_SECRET`, `SIGNALS_AUTH_SECRET`, `SIGNALS_PII_KEY`) | Signing sessions/approval tokens, encrypting PII.                                                                                      | Pre-filled dev values in `.env.example`. Regenerate for any shared host.                                                                   |
| **`127.0.0.1 keycloak` in `/etc/hosts`**                                                           | So the browser and the web container resolve the OIDC issuer to the _same_ Keycloak (issuer-claim validation).                         | You add it once (§2).                                                                                                                      |

### 1.3 Clone both repos

Clone them **side by side as siblings** under a common parent directory so the
compose build contexts (`../../signals-dpg` and `..`) resolve:

```bash
# from a common parent directory of your choosing
git clone <aggregator-dpg-repo-url>  aggregator-dpg
git clone <signals-dpg-repo-url>     signals-dpg
```

If you already have both repos side by side (you do, if you're reading this file
in place at `aggregator-dpg/local-setup/`), skip this step.

---

## 2. Track A — one-command stack (Docker-only)

### 2.1 Configure

```bash
cd aggregator-dpg/local-setup     # all Track A commands run from here
cp .env.example .env
```

Open `.env` and set the **one required edit**:

```dotenv
ADMIN_EMAILS=you@yourorg.com
```

Everything else has working dev defaults. Then add the hosts entry (once):

```bash
# macOS / Linux
echo "127.0.0.1 keycloak" | sudo tee -a /etc/hosts

# Windows (PowerShell as Administrator)
Add-Content C:\Windows\System32\drivers\etc\hosts "127.0.0.1 keycloak"
```

### 2.2 Bring it up

```bash
docker compose up -d --build      # build all app images + start everything
docker compose ps                 # watch until keycloak + aggregator-api are healthy
```

**Low on memory? Build one image at a time.** `--build` builds all app images
**in parallel**, which is what spikes memory (see §0). Build them
**sequentially** first — one at a time, far lower peak memory, and a failure
stops immediately on the offending service — then start without rebuilding:

```bash
# macOS / Linux / Git Bash / WSL — from aggregator-dpg/local-setup/
for s in signals-bootstrap signals-api signals-ui aggregator-api aggregator-worker aggregator-web; do
  docker compose build "$s" || { echo "FAILED at $s"; break; }
done
docker compose up -d              # start; images already built, no --build
```

```powershell
# Windows PowerShell — from aggregator-dpg\local-setup\ (the `;` after `$s` is
# REQUIRED on one line, else `if` is parsed as an argument to docker)
foreach ($s in "signals-bootstrap","signals-api","signals-ui","aggregator-api","aggregator-worker","aggregator-web") { docker compose build $s; if ($LASTEXITCODE -ne 0) { Write-Host "FAILED at $s"; break } }
docker compose up -d              # start; images already built, no --build
```

First run pulls images and builds five app images (~2–3 GB) — budget
**~20 minutes on average** (longer on low-power U-series CPUs, faster on a
desktop). Cached rebuilds after a code change are far quicker. The startup
order is handled automatically:

```
postgres, redis×2, mailpit, minio ─► minio-init (bucket)
                                  ─► keycloak (imports realm)
signals-bootstrap (migrate+seed, runs once) ─► signals-api ─► signals-ui
aggregator-api (auto-migrates on boot) ─► aggregator-web + aggregator-worker
```

Follow logs if anything looks stuck:

```bash
docker compose logs -f keycloak            # realm import / OTP codes
docker compose logs -f signals-bootstrap   # migration + seed + minted apikeys
docker compose logs -f aggregator-api      # migrations + upstream calls
```

### 2.3 URLs

**👉 Start here — the UIs you actually open in a browser:**

| Open this             | URL                   | What it's for                                                      |
| --------------------- | --------------------- | ------------------------------------------------------------------ |
| **Aggregator portal** | http://localhost:3100 | the main app — register / log in, dashboards, uploads              |
| **Signals UI**        | http://localhost:5173 | upstream Signals Stack UI (must be `:5173` — API CORS allows-list) |
| **Mailpit inbox**     | http://localhost:8025 | catches **all** local email — approval links + login OTP mails     |

**Everything else** — APIs, admin consoles & datastores, for debugging / direct access:

| Service          | URL                         | Credentials / notes                                                                       |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| Aggregator API   | http://localhost:4000       | — (`/health/live`)                                                                        |
| Signals API      | http://localhost:2742       | apikey (`/reference` for Swagger)                                                         |
| Keycloak admin   | http://localhost:8080/admin | `admin` / `KC_ADMIN_PASSWORD` from `.env`                                                 |
| MinIO console    | http://localhost:9001       | `minioadmin` / `MINIO_ROOT_PASSWORD`                                                      |
| Postgres         | localhost:5432              | `dpg` / `POSTGRES_PASSWORD` (one shared server; dbs: `aggregator`, `signals`, `keycloak`) |
| signals-redis    | localhost:5555              | password-protected (`SIGNALS_REDIS_PASSWORD`)                                             |
| aggregator-redis | localhost:6379              | —                                                                                         |

> Ports mirror each project's own guide (`signals-dpg/SETUP.md`,
> `aggregator-dpg/QUICKSTART.md`) so nothing conflicts conceptually. The one
> consolidation: the unified stack runs a **single** Postgres on `:5432` holding
> all three databases (the per-repo guides use separate `:5432`/`:5433`).

Continue to §3 (aggregator smoke test) and §4 (cross-DPG wiring).

---

## 3. Smoke test — the aggregator registration + login flow

This exercises Keycloak OTP, the approval email, and the portal end to end.

```
1. http://localhost:3100/register
   → fill the form (type, organisation, email, phone) → submit
2. http://localhost:8025  (Mailpit)
   → open the "approval request" mail addressed to ADMIN_EMAILS
   → click Approve → confirm on the approval page
   → the applicant receives a welcome mail (also in Mailpit)
3. http://localhost:3100/login
   → sign in with the registered email or phone
   → the OTP code arrives in Mailpit (email) or `docker compose logs keycloak` (SMS 'log')
4. First login prompts for first/last name, then lands on the portal.
```

> The realm ships with the `aggregator_id` and `phone_number` protocol mappers
> and `unmanagedAttributePolicy: ENABLED` already baked in — no manual Keycloak
> mapper step is required (older docs mention one; it's obsolete for this realm).

---

## 4. Wire aggregator-dpg → signals-dpg (cross-DPG integration)

By default each DPG runs standalone. To let aggregator-dpg **push** approved
aggregators and onboarded participants **into** signals-dpg, it authenticates
with the two-header service-auth model:

- `x-api-key` — a service apikey minted by signals-dpg's seed script.
- `x-acting-org-id` — the org the call acts on behalf of.

The apikey is generated at seed time, so it can't be pre-baked into `.env`.
Wire it up after the first `up`:

**1. Read the seeded credentials** (printed on the bootstrap's first run only):

```bash
docker compose logs signals-bootstrap
# look for the aggregator-dpg service apikey (prefix sk_signals_...) and the
# aggregator-dpg network_service org id.
```

If the log has scrolled or the seed already ran, re-mint by resetting (§7) or
inspect Postgres:

```bash
docker compose exec postgres psql -U dpg -d signals \
  -c "select o.id, o.name, o.type from organization o where o.type='network_service';"
```

**2. Put them in `.env`:**

```dotenv
SIGNALSTACK_ADMIN_KEY=sk_signals_...................
SIGNALSTACK_ACTING_ORG_ID=org_....................   # aggregator-dpg network_service org id
```

**3. Restart the aggregator services that call upstream:**

```bash
docker compose up -d aggregator-api aggregator-worker
```

**4. Verify** (mirror an aggregator into signals — the pattern documented in
`signals-dpg/docs/operations/integrating-dpgs.md`):

```bash
curl -X POST http://localhost:2742/api/v1/admin/aggregator/upsert \
  -H "x-api-key: $SIGNALSTACK_ADMIN_KEY" \
  -H "x-acting-org-id: $SIGNALSTACK_ACTING_ORG_ID" \
  -H 'Content-Type: application/json' \
  -d '{"external_id":"agg_demo_001","name":"Demo Aggregator","slug":"demo","domains":["seeker","provider"]}'
# -> { "org_id": "org_<uuid>", "created": true }
```

---

## 5. Day-to-day commands (Track A)

```bash
docker compose ps                       # status
docker compose logs -f <service>        # tail one service
docker compose stop                     # stop, keep data
docker compose up -d                    # resume
docker compose up -d --build <service>  # rebuild one app after code changes
docker compose exec postgres psql -U dpg -d aggregator   # psql into a db
```

---

## 6. Track B — hybrid dev (hot-reload)

Run the **backing services in Docker** and **both DPGs from source** with
`pnpm dev`. No app images are built (only the small backing containers run in
Docker), so this is the right track on a low-memory machine. Edit any source
file and that process reloads — no rebuilds.

Ports: signals api `:2742` / ui `:5173`, aggregator api `:4000` / portal
`:3000` (Next's default; Track A publishes the same app on host `:3100`),
keycloak `:8080`, postgres `:5432`, aggregator-redis `:6379`, signals-redis
`:5555`, mailpit `:1025`/`:8025`, minio `:9000`.

Do all three steps in order. You'll end with ~5 terminals open (2 for signals,
2–3 for aggregator).

### Step 1 — Backing services in Docker

From this `local-setup/` directory, start **only** the infra — this builds no
app images:

```bash
cd aggregator-dpg/local-setup
cp .env.example .env                                # then set ADMIN_EMAILS=you@yourorg.com
echo "127.0.0.1 keycloak" | sudo tee -a /etc/hosts  # once (browser + host apps resolve the OIDC issuer)

docker compose up -d \
  postgres signals-redis aggregator-redis \
  keycloak keycloak-init \
  mailpit minio minio-init
docker compose ps                                   # wait until keycloak is healthy
```

Postgres comes up with all three databases (`aggregator`, `signals`,
`keycloak`) already created. Keep three values from this `.env` handy — you
reuse them below:

| From `local-setup/.env`                | Used in                      |
| -------------------------------------- | ---------------------------- |
| `POSTGRES_PASSWORD`                    | signals + aggregator DB URLs |
| `SIGNALS_REDIS_PASSWORD`               | signals redis URL            |
| `APPROVAL_TOKEN_SECRET`, `SESSION_KEY` | aggregator api / web         |

The two OIDC client secrets are the `.env` defaults (already reconciled into
Keycloak by `keycloak-init`): `aggregator-api-dev-secret-change-me` and
`aggregator-portal-dev-secret-change-me`.

### Step 2 — signals-dpg from source

```bash
cd ../../signals-dpg
pnpm install
cp .env.example .env
```

Edit signals `.env` so it points at the **Dockerised** Postgres/Redis from
Step 1 (reuse the same passwords as `local-setup/.env`):

```dotenv
API_PORT=2742
CREATE_TEST_OTP=true
AUTH_MIDDLEWARE_ENABLED=true
SERVED_DOMAINS=blue_dot/seeker,blue_dot/provider

# Shared Postgres — the 'signals' DB already exists (created in Step 1)
POSTGRES_HOST=localhost
DATABASE_PORT=5432
POSTGRES_USER=dpg
POSTGRES_PASSWORD=<POSTGRES_PASSWORD from local-setup/.env>
POSTGRES_DB=signals
POSTGRES_URL=postgres://dpg:<POSTGRES_PASSWORD>@localhost:5432/signals

# signals-redis — password-protected, published on host port 5555
REDIS_HOST=localhost
REDIS_PORT=5555
REDIS_PASSWORD=<SIGNALS_REDIS_PASSWORD from local-setup/.env>
REDIS_URL=redis://:<SIGNALS_REDIS_PASSWORD>@localhost:5555

# 32-byte base64 key — any fresh value is fine locally: openssl rand -base64 32
SIGNALS_PII_KEY=<base64-32-byte-key>
```

Apply schema, seed the service account, then run it:

```bash
pnpm db:push:api           # apply schema (confirm the prompt)
pnpm db:init:api           # partitioned items / actions / events tables
pnpm db:seed:services:api  # mints the aggregator service apikey — COPY the printed key

pnpm dev:api               # signals API on :2742   (terminal 1)
pnpm dev:ui                # signals UI  on :5173   (terminal 2)
```

**Capture two values for Step 3** (the aggregator↔signals wiring):

1. **`SIGNALSTACK_ADMIN_KEY`** — the `sk_signals_…` apikey printed by
   `db:seed:services:api` above.
2. **`SIGNALSTACK_ACTING_ORG_ID`** — the aggregator-dpg service org id. Read it
   from the Dockerised Postgres:

   ```bash
   docker exec sd-postgres psql -U dpg -d signals -t -c \
     "select id from organization where name like 'aggregator-dpg%';"
   # -> org_........................
   ```

### Step 3 — aggregator-dpg from source (+ signals wiring)

```bash
cd ../aggregator-dpg
pnpm install
pnpm -w build   # REQUIRED: internal @aggregator-dpg/* packages export compiled
                # dist/ — db:migrate and dev import those, so build once after install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env   # only if you run the worker (terminal 5)
```

> If you skip `pnpm -w build`, `db:migrate`/`dev` fail with
> `ERR_MODULE_NOT_FOUND: Cannot find module '.../@aggregator-dpg/db-schema/dist/schema.js'`
> — that's an unbuilt workspace package, not a missing dependency. The build is
> Turbo-cached, so re-running it is instant once nothing changed.

`apps/api/.env.example` already ships a complete, working local template — the
S3/Redis/schema/mail defaults all point at the localhost infra from Step 1, so
you only need to **change the values below** (everything else stays as copied).
The `.env.example` defaults target aggregator-dpg's _standalone_ compose
(Postgres on `:5433`); the unified stack uses one shared Postgres on `:5432`, so
`DATABASE_URL` and a couple of others differ:

```dotenv
# Shared Postgres from Step 1 (note :5432 and user dpg — differ from the default)
DATABASE_URL=postgres://dpg:<POSTGRES_PASSWORD from local-setup/.env>@localhost:5432/aggregator

# Issuer must be keycloak:8080 (not localhost) — see the note below
KEYCLOAK_URL=http://keycloak:8080

# Your values
APPROVAL_TOKEN_SECRET=<same as local-setup/.env, >=32 chars>
ADMIN_EMAILS=you@yourorg.com

# SignalStack wiring — the two values captured in Step 2
SIGNALSTACK_BASE_URL=http://localhost:2742
SIGNALSTACK_ADMIN_KEY=sk_signals_....................
SIGNALSTACK_ACTING_ORG_ID=org_....................
```

`apps/web/.env.example` is likewise complete for local dev — the client
secrets, redirect URI (`:3000`), Redis and API URLs all match this stack. Change
only these two:

```dotenv
# Issuer must be keycloak:8080 (not localhost) — same reason as the API
OIDC_ISSUER=http://keycloak:8080/realms/aggregator
# Signed-cookie key
SESSION_KEY=<same as local-setup/.env, >=32 chars>
```

If you run the worker, change these in **`apps/worker/.env`** (it has no OIDC —
just DB + the SignalStack push; note there's **no** acting-org here):

```dotenv
DATABASE_URL=postgres://dpg:<POSTGRES_PASSWORD from local-setup/.env>@localhost:5432/aggregator
SIGNALSTACK_BASE_URL=http://localhost:2742
SIGNALSTACK_ADMIN_KEY=sk_signals_....................
```

Migrate and run:

```bash
pnpm --filter @aggregator-dpg/api db:migrate       # apply aggregator migrations
pnpm --filter @aggregator-dpg/api dev              # API on :4000    (terminal 3)
pnpm --filter @aggregator-dpg/web dev              # portal on :3000 (terminal 4)
pnpm --filter @aggregator-dpg/worker dev           # worker (terminal 5, optional)
```

Open **http://localhost:3000** and run the smoke test in §3.

> **Wiring gotcha, baked into the values above:**
>
> - **Keep every URL on one port.** The Keycloak realm whitelists **both**
>   `localhost:3000` and `localhost:3100` (redirect URIs + web origins), so the
>   portal can run on either — this guide uses Next's default `:3000`. Just make
>   sure `PUBLIC_PORTAL_URL`, `OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_REDIRECT_URI`
>   and `CORS_ORIGINS` all use the **same** port you actually serve on, or the
>   OIDC redirect / CORS will fail. (Track A uses `:3100` because the compose
>   publishes the container's internal `:3000` on host port `:3100`.)
> - **`keycloak:8080`, not `localhost:8080`, for `OIDC_ISSUER`.** Keycloak
>   issues tokens with the issuer `http://keycloak:8080/…`; the app must use the
>   same hostname or the `iss` claim won't validate. The `/etc/hosts` entry from
>   Step 1 makes `keycloak` resolve to your machine.
>
> **Login OTP in dev:** email OTPs land in Mailpit (http://localhost:8025);
> phone/SMS OTPs are written to the Keycloak container logs
> (`docker compose logs keycloak | grep -i otp`).

---

## 7. Reset

**Track A (unified):**

```bash
docker compose down            # stop + remove containers, keep data
docker compose down -v         # ALSO wipe all data volumes (fresh DBs on next up)
docker compose up -d --build   # rebuild from scratch; re-runs migrate + seed
```

Wiping volumes re-runs `signals-bootstrap`, which **mints new apikeys** — redo
§4 with the new values.

**Track B:** stop the `pnpm dev` processes, then from `local-setup/` run
`docker compose down -v` to wipe the backing volumes. On the next run, redo
Step 2 (`db:push:api` / `db:init:api` / `db:seed:services:api`) and Step 3
(`db:migrate`) — and because the seed **mints a new apikey**, re-copy the new
`SIGNALSTACK_ADMIN_KEY` / `SIGNALSTACK_ACTING_ORG_ID` into `apps/api/.env`.

---

## 8. Troubleshooting

| Symptom                                                                                                                                                               | Cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port is already allocated` on `up`                                                                                                                                   | Another local process holds one of the host ports (`5432`, `5555`, `6379`, `8080`, `5173`, `2742`, `3100`, `4000`, `8025`, `9000/9001`). Stop it, or edit the host-port mapping in `docker-compose.yml`. Host-native processes (e.g. a Homebrew Postgres on 5432) are NOT freed by stopping Docker containers.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Browser can't reach `http://keycloak:8080` / login redirect fails                                                                                                     | Missing `127.0.0.1 keycloak` in `/etc/hosts` (§2.1). Re-add and retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Login redirects to `/login?error=invalid_flow_cookie`                                                                                                                 | Portal is HTTP but cookies are Secure. The unified compose sets `COOKIE_SECURE=false`; if you changed it, revert and `docker compose up -d aggregator-web`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `403 MISSING_AGGREGATOR_ID` on the profile endpoint                                                                                                                   | Keycloak `aggregator_id` mapper missing. The unified realm bakes it in — if you swapped realms, re-import (`down -v` + `up`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Registration **approval link** won't load / opens on :4000 and 404s ("identity record missing")                                                                       | Two causes, both fixed in the compose: (a) `aggregator-api` must publish `:4000` (the approve/reject pages are API-rendered HTML linked from the email); (b) Keycloak's `unmanagedAttributePolicy` must be `ENABLED` or the `aggregator_id` user attribute is silently dropped and the lookup 404s. The `keycloak-init` sidecar sets the policy at boot — if it didn't run, `docker compose up keycloak-init`. Users registered _before_ the policy was enabled won't have the attribute — re-register (or `down -v` + `up` for a clean slate).                                                                                                                                                                                                                           |
| `AGGREGATOR_TYPE_MISSING` on onboarding (bulk upload / links)                                                                                                         | Same root cause as above — the `aggregator_type` KC attribute was dropped at registration (policy DISABLED then), so the JWT has no `aggregator_type` claim. Fixed for new registrations by the `keycloak-init` sidecar. For an already-registered user: **sign out and back in** to mint a fresh token (the claim only appears in a new token); if the attribute itself is missing, re-register or `down -v` + `up`.                                                                                                                                                                                                                                                                                                                                                     |
| `signals-api` restarts / "relation does not exist"                                                                                                                    | `signals-bootstrap` didn't finish. Check `docker compose logs signals-bootstrap`; re-run with `docker compose up -d --force-recreate signals-bootstrap signals-api`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `signals-bootstrap` fails on `SIGNALS_PII_KEY`                                                                                                                        | It must be base64 that decodes to exactly 32 bytes: `openssl rand -base64 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| aggregator upstream calls 403 `INVALID_API_KEY`                                                                                                                       | `SIGNALSTACK_ADMIN_KEY` doesn't match a seeded key. Re-read §4 step 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| No email arrives                                                                                                                                                      | It's not actually delivered locally — open Mailpit at http://localhost:8025.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| OTP code never emailed                                                                                                                                                | For phone/SMS OTP the `log` provider prints it: `docker compose logs keycloak \| grep -i otp`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| First `up --build` is very slow                                                                                                                                       | Normal — five app images build from source. Subsequent ups are cached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Windows:** keycloak container is stuck `Restarting (255)` and logs repeat `exec /opt/keycloak/render-realm.sh: no such file or directory` (the file clearly exists) | CRLF line endings in the mounted entrypoint script. The trailing `\r` on the `#!/bin/sh` shebang makes the Linux kernel look for interpreter `/bin/sh\r`, which doesn't exist — hence the misleading "no such file or directory". Same root cause and fix as the row below; renormalize the working-tree `*.sh` to LF, then `docker compose up -d keycloak keycloak-init` (bind mount — no rebuild needed). Confirm with `git ls-files --eol infra/keycloak/render-realm.sh` showing `w/lf`.                                                                                                                                                                                                                                                                              |
| **Windows:** `keycloak-init` (or `postgres-init`) container fails immediately — logs show `\r`, `set: illegal option`, or `syntax error: unexpected end of file`      | CRLF line endings. A Windows checkout rewrites the container shell scripts to CRLF, which the Linux `#!/bin/sh` + `set -eu` can't run. The repo's `.gitattributes` pins `*.sh` to LF, but files checked out **before** it existed stay CRLF on disk (git never renormalizes an existing working tree — this happens even with `core.autocrlf=false`, and `git ls-files --eol` then shows `i/lf w/crlf`). Renormalize the working tree in place — no destructive reset needed: `git add --renormalize . && git checkout -- .` (or, to touch only the scripts: `git ls-files '*.sh' -z \| xargs -0 rm -f && git checkout -- $(git ls-files '*.sh')`). Then restart the affected containers (or `docker compose down -v && docker compose up -d --build` for a clean slate). |

---

## 9. How the pieces fit (reference)

```
                      Browser (http://localhost:3100)
                               │  OIDC (code + PKCE)
                               ▼
   ┌───────────────┐     ┌──────────────┐        ┌──────────────────┐
   │  Keycloak      │◀───▶│ aggregator-web│──────▶│  aggregator-api   │
   │  :8080         │     │ (Next.js BFF) │        │  (Fastify) :4000  │
   │  realm=aggreg. │     └──────────────┘        └────────┬─────────┘
   └───────────────┘                                       │  x-api-key +
        ▲  OTP mail                                         │  x-acting-org-id
        │                                                   ▼
   ┌────┴─────┐   ┌───────────┐   ┌──────────┐      ┌──────────────────┐
   │ Mailpit  │   │  MinIO     │   │ aggreg.  │      │  signals-api      │
   │ :8025    │   │  :9000/1   │◀──│ worker   │      │  (Fastify) :2742  │
   └──────────┘   └───────────┘   └──────────┘      └────────┬─────────┘
                                                              │
   ┌──────────────────────── shared Postgres :5432 ──────────┼──────────┐
   │  aggregator db        signals db        keycloak db      │          │
   └─────────────────────────────────────────────────────────┘          │
   signals-redis :5555 (pw)      aggregator-redis :6379     signals-ui :5173
```

- **Auth:** aggregator uses **Keycloak** (OIDC + email/phone OTP). signals uses
  **better-auth** with its own OTP. They are separate identity systems.
- **Cross-DPG:** aggregator-api / worker call signals-api over the two-header
  service-auth model (`x-api-key` + `x-acting-org-id`) — see §4 and
  `signals-dpg/docs/operations/integrating-dpgs.md`.
- **Networks/domains:** both are configured for the `blue_dot` network with
  `seeker` + `provider` domains. Change `AGGREGATOR_NETWORK` /
  `SIGNALS_SERVED_DOMAINS` in `.env` to target another (e.g. `purple_dot`).

### Per-repo deep dives

- `aggregator-dpg/SETUP.md`, `aggregator-dpg/QUICKSTART.md` — the canonical
  aggregator setup (both dev and VM/prod), Keycloak details, troubleshooting.
- `aggregator-dpg/README.md` — the full product/technical spec.
- `signals-dpg/SETUP.md` — **canonical** signals local setup (host + db/redis
  containers), the "choose a network" table, and the aggregator integration via
  `host.docker.internal`. Mirrors Track B here.
- `signals-dpg/readme.md`, `signals-dpg/AGENTS.md` — signals commands,
  conventions, and the item/action/event model.
- `signals-dpg/docs/operations/` — integrating DPGs, migrations, secrets.
- `../../CLAUDE.md` (workspace root, one level above both repos) — orientation
  for the two-project layout.
- `../CLAUDE.md` (aggregator-dpg repo root) — the authoritative agent/dev doc
  for this repo.
