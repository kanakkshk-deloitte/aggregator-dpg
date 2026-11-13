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

| Track               | You want to…                                                                              | Follow                 |
| ------------------- | ----------------------------------------------------------------------------------------- | ---------------------- |
| **A — Docker-only** | Just get everything running to explore/demo the apps. One command.                        | §1 → §2 → §3 → §5      |
| **B — Hybrid dev**  | Write code with hot-reload; both DPGs run from source.                                    | §1 → §6 (3 steps) → §3 |
| **A with search**   | Track A plus signals-search (relevance-ranked discover, match scores; ~4 GB more memory). | Track A + §10          |

Both tracks share the same prerequisites (§1). Track A uses the unified
`docker-compose.yml` in this `local-setup/` directory. Track B runs each app
with `pnpm dev` against Dockerised backing services, using each repo's own
tooling.

> **⚠️ Memory guidance.** Track A builds **5 app images** and then runs **~14
> containers** — budget **≈ 6 GB of Docker memory** (Docker Desktop → Settings →
> Resources → Memory), or **≥ 10 GB with search** (§10: three more containers,
> and the embedding server alone wants 3-4 GB) on a 16 GB machine. On an **8 GB machine** (where
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

| Tool                        | Version                              | Needed for                      | Notes                                                             |
| --------------------------- | ------------------------------------ | ------------------------------- | ----------------------------------------------------------------- |
| **Docker + Docker Compose** | recent (v2)                          | both tracks                     | Docker Desktop on macOS/Windows; engine + compose plugin on Linux |
| **Node.js**                 | ≥ 24 (22 works for dev)              | Track B; Track A never needs it | CI pins 24                                                        |
| **pnpm**                    | 10.x (aggregator) / 11.1.2 (signals) | Track B                         | `npm i -g pnpm` or `corepack enable pnpm`                         |
| **openssl**                 | any                                  | generating secrets              | pre-shipped on macOS/Linux                                        |
| **git**                     | any                                  | cloning                         | —                                                                 |
| **`docker login dhi.io`**   | —                                    | **Track A**                     | Only for building images. See note below.                         |

> **Track A needs a registry login.** The api, web and worker images build `FROM
dhi.io/...` (Docker Hardened Images), and dhi.io refuses anonymous pulls — so
> `docker compose up -d --build` fails at the first `FROM` with `401
Unauthorized` unless you have run `docker login dhi.io` with a Docker Hub
> account. Track B needs no login: it builds no app images. signals-dpg's
> `local-setup/LOCAL_SETUP.md` carries the same note.
>
> Check the login before the first build — a stale entry in
> `~/.docker/config.json` looks logged in but still gets the 401, and the first
> image (`signals-bootstrap`) builds without it, so the failure only shows up at
> `signals-api`:
>
> ```bash
> docker login dhi.io
> docker pull dhi.io/node:24-alpine   # must succeed before you build
> ```
>
> | A REST client (curl / Postman / HTTPie) | — | poking APIs, cross-DPG wiring | optional |

You do **not** need a real AWS account, a real SMTP server, or a real SMS
gateway for local setup — the unified stack substitutes MinIO (for S3), Mailpit
(for email), and Keycloak's `log` SMS provider (OTP codes print to logs).

### 1.2 Functional prerequisites (things that aren't software)

These are the human/config inputs the apps expect. The unified `.env.example`
pre-fills everything except the first item and the secrets, which
`gen-secrets.sh` generates for you.

| Prerequisite                                                                                                                                                                                                       | Why it's needed                                                                                                                        | Local default                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Admin email address** (`ADMIN_EMAILS`)                                                                                                                                                                           | aggregator-dpg emails new-aggregator **approval requests** here. You approve/reject from this inbox to complete the registration flow. | Optional — defaults to `admin@bluedots.local`. Any address works; the mail is captured by Mailpit, not actually delivered.                 |
| **SMTP account**                                                                                                                                                                                                   | Sending real approval + OTP email in staging/prod.                                                                                     | Not needed locally (Mailpit catches all). For real email use a Gmail **App Password** (not your login password) or Amazon SES.             |
| **SMS / OTP provider**                                                                                                                                                                                             | Delivering login OTPs by phone in prod (Twilio / AWS SNS / MSG91).                                                                     | Not needed locally — Keycloak's `log` provider writes the code to `docker compose logs keycloak`; signals-dpg sets `CREATE_TEST_OTP=true`. |
| **S3 bucket + credentials**                                                                                                                                                                                        | aggregator bulk-uploads, QR PNGs, error CSVs in prod.                                                                                  | Not needed locally — MinIO provides an S3-compatible endpoint and the bucket is auto-created.                                              |
| **App secrets + infra passwords** (`SESSION_KEY`, `APPROVAL_TOKEN_SECRET`, `SIGNALS_AUTH_SECRET`, `SIGNALS_PII_KEY`, `POSTGRES_PASSWORD`, `SIGNALS_REDIS_PASSWORD`, `KC_ADMIN_PASSWORD`, `SIGNALS_SEARCH_API_KEY`) | Signing sessions/approval tokens, encrypting PII, and the local Postgres/Redis/Keycloak logins.                                        | Ship as `CHANGE_ME_*` placeholders. Run `./gen-secrets.sh` after copying `.env` — it fills each one with a fresh random value.             |
| **`127.0.0.1 keycloak` in `/etc/hosts`**                                                                                                                                                                           | So the browser and the web container resolve the OIDC issuer to the _same_ Keycloak (issuer-claim validation).                         | You add it once (§2).                                                                                                                      |

### 1.3 Clone both repos

Clone them **side by side as siblings** under a common parent directory so the
compose build contexts (`../../signals-dpg` and `..`) resolve:

```bash
# from a common parent directory of your choosing
git clone https://github.com/Blue-Dots-Economy/aggregator-dpg.git
git clone https://github.com/Blue-Dots-Economy/signals-dpg.git
```

If you already have both repos side by side (you do, if you're reading this file
in place at `aggregator-dpg/local-setup/`), skip this step.

---

## 2. Track A — one-command stack (Docker-only)

### 2.1 Configure

```bash
cd aggregator-dpg/local-setup     # all Track A commands run from here
cp .env.example .env
./gen-secrets.sh                  # fills every CHANGE_ME_* with a random value
```

Everything has working defaults — no edits needed. Approval mails go to
`ADMIN_EMAILS` (`admin@bluedots.local` by default) and land in Mailpit; change it
only if you want a different address. Then add the hosts entry (once):

```bash
# macOS / Linux
grep -qE '^[[:space:]]*127\.0\.0\.1[[:space:]]+keycloak([[:space:]]|$)' /etc/hosts \
  || sudo sh -c "printf '\n127.0.0.1 keycloak\n' >> /etc/hosts"

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
                                            ─► signals-search-api + signals-search-worker  (search file only)
tei-embeddings (bge-m3, ~30-60s warm-up)                                                   (search file only)
aggregator-api (auto-migrates on boot) ─► aggregator-web + aggregator-worker
```

Follow logs if anything looks stuck:

```bash
docker compose logs -f keycloak            # realm import / OTP codes
docker compose logs -f signals-bootstrap   # migration + seed
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

| Service          | URL                         | Credentials / notes                                                                                                                             |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregator API   | http://localhost:4000       | — (`/health/live`). Served **through the edge** (`aggregator-envoy`: Envoy + OPA check every request first; docs/rbac/rbac-edge-enforcement.md) |
| Edge admin       | http://localhost:9901       | Envoy admin (`/ready`, `/stats`); the edge's per-request verdicts are in `docker compose logs aggregator-envoy` (`operation: rbac.edge`)        |
| OPA              | http://localhost:8181       | RBAC policy (`policy/rbac`); `GET /v1/data/catalogue` shows the role catalogue the API pushed for the edge                                      |
| Signals API      | http://localhost:2742       | apikey (`/api/reference` for Swagger)                                                                                                           |
| Keycloak admin   | http://localhost:8080/admin | `admin` / `KC_ADMIN_PASSWORD` from `.env`                                                                                                       |
| MinIO console    | http://localhost:9001       | `minioadmin` / `MINIO_ROOT_PASSWORD`                                                                                                            |
| Postgres         | localhost:5432              | `dpg` / `POSTGRES_PASSWORD` (one shared server; dbs: `aggregator`, `signals`, `keycloak`)                                                       |
| signals-redis    | localhost:5555              | password-protected (`SIGNALS_REDIS_PASSWORD`)                                                                                                   |
| Signals Search   | http://localhost:3110       | §10. **3110, not 3100** — the portal owns 3100. `POST /v1/search` needs `x-api-key` (`SIGNALS_SEARCH_API_KEY`)                                  |
| aggregator-redis | localhost:6379              | —                                                                                                                                               |

> Ports mirror each project's own guide (`signals-dpg/SETUP.md`,
> `aggregator-dpg/QUICKSTART.md`) so nothing conflicts conceptually. The one
> consolidation: the unified stack runs a **single** Postgres on `:5432` holding
> all three databases (the per-repo guides use separate `:5432`/`:5433`).

Continue to §3 (aggregator smoke test), §4 (cross-DPG check) and §10 (search check).

---

## 3. Smoke test — the aggregator registration + login flow

This exercises Keycloak OTP, the approval email, and the portal end to end.

An organisation registers first and invites its coordinators:

```
1. http://localhost:3100/register/owner
   → register the organisation (owner email + phone) → submit
2. http://localhost:8025  (Mailpit)
   → open the "approval request" mail (sent to ADMIN_EMAILS, admin@bluedots.local by default)
   → click Approve → confirm on the approval page
   → the owner receives a mail with an invite link (/register/invite?grant=…)
3. Open the invite link → invite a coordinator by email
4. Mailpit → open the coordinator invite → register through it (/register/coordinator?invite=…)
5. Mailpit → approve the coordinator's registration, as in step 2
6. http://localhost:3100/login
   → sign in as the coordinator with the registered email or phone
   → the OTP code arrives in Mailpit (email) or `docker compose logs keycloak` (SMS 'log')
7. First login prompts for first/last name, then lands on the portal.
```

Once approved, the owner can also sign in at `/login` and lands on the
organisation console (`/console`), where they invite and approve coordinators.
A coordinator with no organisation of their own registers at `/register` and
picks the **Default** organisation; that review mail goes to
`DEFAULT_ORG_OWNER_EMAIL`, or `ADMIN_EMAILS` when it is unset.

> The realm ships with the `aggregator_id` and `phone_number` protocol mappers
> and `unmanagedAttributePolicy: ENABLED` already baked in — no manual Keycloak
> mapper step is required (older docs mention one; it's obsolete for this realm).

---

## 4. aggregator-dpg → signals-dpg (cross-DPG integration)

aggregator-dpg **pushes** approved aggregators and onboarded participants
**into** signals-dpg. This is wired automatically — nothing to copy:

- aggregator-api and aggregator-worker authenticate with a Keycloak
  client-credentials token (`SIGNALSTACK_AUTH_MODE=bearer`) for the
  `aggregator-dpg` client. Its secret, `SIGNALSTACK_CLIENT_SECRET`, is rendered
  into the realm by the `keycloak` service from the same `.env` value.
- signals-api accepts that client (`KEYCLOAK_SERVICE_CLIENT_IDS=aggregator-dpg`)
  and maps it to the org whose slug is `aggregator-dpg`.
- `signals-bootstrap` seeds that org with the fixed id `AGGREGATOR_DPG_ORG_ID`
  from `.env`; aggregator-api sends the same id as `x-acting-org-id`.

**Verify** (mirror an aggregator into signals — the pattern documented in
`signals-dpg/docs/operations/integrating-dpgs.md`):

```bash
set -a; . ./.env; set +a
TOKEN=$(curl -s http://keycloak:8080/realms/$KEYCLOAK_REALM/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=aggregator-dpg \
  -d client_secret="$SIGNALSTACK_CLIENT_SECRET" | sed 's/.*"access_token":"\([^"]*\)".*/\1/')
curl -X POST http://localhost:2742/api/v1/admin/aggregator/upsert \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-acting-org-id: $AGGREGATOR_DPG_ORG_ID" \
  -H 'Content-Type: application/json' \
  -d '{"external_id":"agg_demo_001","name":"Demo Aggregator","slug":"demo","domains":["seeker","provider"]}'
# -> { "org_id": "org_<uuid>", "created": true }
```

> The seed applies `AGGREGATOR_DPG_ORG_ID` and `SIGNALS_SEARCH_API_KEY` only
> when it first creates the rows. If you change either one in `.env` after the
> first `up`, reset with `down -v` (§7).

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
cp .env.example .env
./gen-secrets.sh                                    # fills every CHANGE_ME_* value
# once (browser + host apps resolve the OIDC issuer); safe to re-run
grep -qE '^[[:space:]]*127\.0\.0\.1[[:space:]]+keycloak([[:space:]]|$)' /etc/hosts \
  || sudo sh -c "printf '\n127.0.0.1 keycloak\n' >> /etc/hosts"

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

The three client secrets default to localhost-only dev values, rendered into
the realm import by `render-realm.sh` (override via `OIDC_API_CLIENT_SECRET`,
`OIDC_PORTAL_CLIENT_SECRET`, `OIDC_BFF_CLIENT_SECRET`):
`aggregator-api-local-dev-secret` (aggregator-api), `aggregator-portal-local-dev-secret`
(aggregator-portal), and `aggregator-bff-local-dev-secret` (the dedicated
minimal-scope `aggregator-bff` client the web BFF uses — never `aggregator-api`).

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

# Keycloak from Step 1; accept the aggregator's client-credentials token
AUTH_PROVIDER=keycloak
KEYCLOAK_BASE_URL=http://keycloak:8080
KEYCLOAK_API_CLIENT_ID=signals-api
KEYCLOAK_API_CLIENT_SECRET=signals-api-local-dev-secret
KEYCLOAK_SERVICE_CLIENT_IDS=aggregator-dpg

# Seeded as the aggregator-dpg org id — same value as local-setup/.env
AGGREGATOR_DPG_ORG_ID=org_00000000-0000-4000-8000-00000000a001
```

Apply schema, seed the service account, then run it:

```bash
pnpm db:push:api           # apply schema (confirm the prompt)
pnpm db:init:api           # partitioned items / actions / events tables
pnpm db:seed:services:api  # seeds the aggregator-dpg org (id from AGGREGATOR_DPG_ORG_ID)

pnpm dev:api               # signals API on :2742   (terminal 1)
pnpm dev:ui                # signals UI  on :5173   (terminal 2)
```

Nothing to capture: the aggregator authenticates with a Keycloak token, and the
org id is the `AGGREGATOR_DPG_ORG_ID` set above.

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

# SignalStack wiring — Keycloak client-credentials token + the org id from Step 2
SIGNALSTACK_BASE_URL=http://localhost:2742
SIGNALSTACK_AUTH_MODE=bearer
SIGNALSTACK_CLIENT_ID=aggregator-dpg
SIGNALSTACK_CLIENT_SECRET=aggregator-dpg-signals-local-dev-secret
SIGNALSTACK_ACTING_ORG_ID=org_00000000-0000-4000-8000-00000000a001
```

`apps/web/.env.example` is likewise complete for local dev — the client
secrets, redirect URI (`:3000`), Redis and API URLs all match this stack. Change
only these two:

```dotenv
# Issuer must be keycloak:8080 (not localhost) — same reason as the API
OIDC_ISSUER=http://keycloak:8080/realms/bluedots
# Signed-cookie key
SESSION_KEY=<same as local-setup/.env, >=32 chars>
```

If you run the worker, change these in **`apps/worker/.env`** (it has no OIDC —
just DB + the SignalStack push; note there's **no** acting-org here):

```dotenv
DATABASE_URL=postgres://dpg:<POSTGRES_PASSWORD from local-setup/.env>@localhost:5432/aggregator
SIGNALSTACK_BASE_URL=http://localhost:2742
SIGNALSTACK_AUTH_MODE=bearer
SIGNALSTACK_CLIENT_ID=aggregator-dpg
SIGNALSTACK_CLIENT_SECRET=aggregator-dpg-signals-local-dev-secret
KEYCLOAK_URL=http://keycloak:8080
KEYCLOAK_REALM=bluedots
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

Wiping volumes re-runs `signals-bootstrap`, which seeds the same
`AGGREGATOR_DPG_ORG_ID` / `SIGNALS_SEARCH_API_KEY` from `.env` again — nothing to
re-wire.

**Track B:** stop the `pnpm dev` processes, then from `local-setup/` run
`docker compose down -v` to wipe the backing volumes. On the next run, redo
Step 2 (`db:push:api` / `db:init:api` / `db:seed:services:api`) and Step 3
(`db:migrate`). The seed reuses `AGGREGATOR_DPG_ORG_ID` from the signals `.env`,
so `apps/api/.env` needs no change.

---

## 8. Troubleshooting

| Symptom                                                                                                                                                               | Cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port is already allocated` on `up`                                                                                                                                   | Another local process holds one of the host ports (`5432`, `5555`, `6379`, `8080`, `5173`, `2742`, `3100`, `3110`, `4000`, `8025`, `8181`, `9901`, `9000/9001`). Stop it, or edit the host-port mapping in `docker-compose.yml`. Host-native processes (e.g. a Homebrew Postgres on 5432, or a signals `pnpm dev` on 2742) are NOT freed by stopping Docker containers. Find the owner with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.                                                                                                                                                                                                                                                                                                                                         |
| Browser can't reach `http://keycloak:8080` / login redirect fails                                                                                                     | Missing `127.0.0.1 keycloak` in `/etc/hosts` (§2.1). Re-add and retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Login redirects to `/login?error=invalid_flow_cookie`                                                                                                                 | Portal is HTTP but cookies are Secure. The unified compose sets `COOKIE_SECURE=false`; if you changed it, revert and `docker compose up -d aggregator-web`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `403 MISSING_AGGREGATOR_ID` on the profile endpoint                                                                                                                   | Keycloak `aggregator_id` mapper missing. The unified realm bakes it in — if you swapped realms, re-import (`down -v` + `up`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Registration **approval link** won't load / opens on :4000 and 404s ("identity record missing")                                                                       | Two causes, both fixed in the compose: (a) `:4000` must be published — by `aggregator-envoy`, which forwards to the API (the approve/reject pages are API-rendered HTML linked from the email); (b) Keycloak's `unmanagedAttributePolicy` must be `ENABLED` or the `aggregator_id` user attribute is silently dropped and the lookup 404s. The `keycloak-init` sidecar sets the policy at boot — if it didn't run, `docker compose up keycloak-init`. Users registered _before_ the policy was enabled won't have the attribute — re-register (or `down -v` + `up` for a clean slate).                                                                                                                                                                                    |
| `AGGREGATOR_TYPE_MISSING` on onboarding (bulk upload / links)                                                                                                         | Same root cause as above — the `aggregator_type` KC attribute was dropped at registration (policy DISABLED then), so the JWT has no `aggregator_type` claim. Fixed for new registrations by the `keycloak-init` sidecar. For an already-registered user: **sign out and back in** to mint a fresh token (the claim only appears in a new token); if the attribute itself is missing, re-register or `down -v` + `up`.                                                                                                                                                                                                                                                                                                                                                     |
| `signals-api` restarts / "relation does not exist"                                                                                                                    | `signals-bootstrap` didn't finish. Check `docker compose logs signals-bootstrap`; re-run with `docker compose up -d --force-recreate signals-bootstrap signals-api`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `signals-bootstrap` fails on `SIGNALS_PII_KEY`                                                                                                                        | It must be base64 that decodes to exactly 32 bytes: `openssl rand -base64 32`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| signals-search 401 `INVALID_API_KEY`                                                                                                                                  | `SIGNALS_SEARCH_API_KEY` in `.env` was changed after the first seed. Run `./gen-secrets.sh` (it re-derives `SIGNALS_SEARCH_API_KEY_HASH`), then `docker compose down -v && docker compose up -d` (§7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
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
   │  realm=bluedots│     └──────────────┘        └────────┬─────────┘
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

- **Auth:** one Keycloak, one `bluedots` realm, shared by both DPGs — their
  clients (`aggregator-portal`/`aggregator-api`/`aggregator-bff` and
  `signals-ui`/`signals-api`) live side by side in it. signals-api runs with
  `AUTH_PROVIDER=keycloak` — Keycloak is the only accepted issuer. The earlier
  transitional `dual` mode (Keycloak token _alongside_ a better-auth session)
  has been removed from signals-dpg, and its `assertAuthProviderSupported`
  guard hard-fails at boot on any other value, so this is not optional.
  aggregator's own login is unaffected. signals-api runs with
  `SELF_SIGNUP_MODE=allowed` (matching
  signals-dpg's own local-setup default) so a Keycloak identity with no
  pre-existing local `user` row can still complete first login through
  signals-ui — set `SELF_SIGNUP_MODE=gated` in `.env` to test the admin-onboarded
  flow instead, at the cost of that first-login path failing with
  `SELF_SIGNUP_DISABLED` for any user not pre-seeded into the signals db.
- **Cross-DPG:** aggregator-api / worker still call signals-api over the
  two-header service-auth model (`x-api-key` + `x-acting-org-id`) — see §4 and
  `signals-dpg/docs/operations/integrating-dpgs.md`. Moving this to a Keycloak
  client-credentials bearer token is a separate, not-yet-done phase; the
  `aggregator-dpg` service client already exists in the realm (unused until
  then).
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

---

## 10. signals-search (relevance ranking + match score)

`docker-compose.yml` runs the stack **without** search: discover uses the native
path (recency/distance order, text and facet filters still applied; the UI shows
_"Showing basic matches — relevance ranking is temporarily unavailable"_) and
match scores are unavailable.

`docker-compose.search.yml` includes `docker-compose.yml` and adds
`sd-signals-search-api`, `sd-signals-search-worker` and `sd-tei-embeddings`:

```bash
docker compose -f docker-compose.search.yml up -d --build
```

Nothing else changes: `SIGNALS_SEARCH_API_KEY` is generated by `gen-secrets.sh`
and seeded by `signals-bootstrap` either way. See §10.3 for adding or removing it
on a running stack.

> **The canonical documentation for signals-search's configuration lives in
> `signals-dpg/local-setup/LOCAL_SETUP.md` §7** — the apikey-table auth, the
> `network.json` requirements, the four-place embedding-dimension lock, and the
> error-keyed troubleshooting table. This section covers only what differs in
> the unified stack.

signals-search is **built from its `main` branch on GitHub** on start: no
`signals-search` checkout, and no image tag to keep current (only release tags
publish images). The build uses `dhi.io` base images, so it needs the same
`docker login dhi.io` as the rest of the stack. The first start takes a few
minutes longer while it builds. To run a published release image instead, set
`SIGNALS_SEARCH_IMAGE=ghcr.io/blue-dots-economy/signals-search:<release-tag>` and
`SIGNALS_SEARCH_PULL_POLICY=missing` in `.env`. `SIGNALS_SEARCH_GIT` points the
build at another branch or fork.

> **On Apple Silicon / arm64 the embedder runs emulated.** Upstream TEI has no
> arm64 build, so the compose pins `platform: linux/amd64` on `tei-embeddings`;
> without it the pull fails with `no matching manifest for linux/arm64/v8`. It
> works (bge-m3 serves a 1024-dim embedding ~35s after start on an M-series
> host), just slower. The search app is built natively, so it needs nothing
> extra. If you switch to a published signals-search image, that image is
> amd64-only: also set `DOCKER_DEFAULT_PLATFORM=linux/amd64`.

### 10.1 What differs from signals-dpg's own stack

|                      | signals-dpg stack                         | here                                                                                                                                                                                |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enabled              | opt-in `--profile search` + `.env.search` | opt-in: `docker compose -f docker-compose.search.yml up -d` (§10)                                                                                                                   |
| Search API host port | `3100`                                    | **`3110`** — the aggregator portal already owns 3100. The container still listens on 3100, so in-compose URLs are unchanged.                                                        |
| API key              | minted by the seed, copied by hand        | `SIGNALS_SEARCH_API_KEY` from `.env`, seeded by `signals-bootstrap` as the `signals-search` apikey                                                                                  |
| Database             | the single `postgresdb`                   | the **`signals`** database specifically; this Postgres also holds `aggregator` and `keycloak`. Pointing search at the wrong one gives `401`s (no `apikey` rows) and an empty index. |
| Redis                | `redis`                                   | `signals-redis` — signals-search shares the _signals_ Redis, because that is where the ingestion stream lives. Not `aggregator-redis`.                                              |
| `network.json`       | `../examples/...`                         | `../../signals-dpg/examples/schemas/blue_dot/network.json` — from the sibling checkout, so both services agree on domains and permitted interactions.                               |

signals-api always has **both** search config blocks — `SIGNALS_SEARCH_URL` (discover)
and `MATCH_SCORE_PROVIDER` + `SIGNALS_SEARCH_ENDPOINT` (match score) — because
they read the same URL under different names. They use the compose service name
and container port (`signals-search-api:3100`), not `localhost:3110`.

### 10.2 Smoke test

`/health` is unauthenticated and checks neither the database nor the embedder, so
a 200 there proves only that the process is up. Run a real query:

```bash
set -a; . ./.env; set +a
curl -sS -X POST http://localhost:3110/v1/search \
  -H 'content-type: application/json' \
  -H "x-api-key: $SIGNALS_SEARCH_API_KEY" \
  -d '{
        "context": {
          "messageId": "local-smoke-1",
          "networkId": "blue_dot",
          "domain": "seeker",
          "itemType": "job_1.0"
        },
        "message": { "intent": { "text": "electrician in Ghaziabad" } }
      }'
```

All four `context` fields are **required** — omitting `messageId` or `itemType`
gets you a `400 VALIDATION_ERROR`, not a 401, because validation runs before auth.
`itemType` must be a type the mounted `network.json` actually declares for that
domain.

A `200` with a `message.items` array means the whole chain worked: apikey row →
network config → embedder → pgvector index:

```json
{"context":{...},"message":{"items":[],"meta":{"total":0,"limit":20,"offset":0}}}
```

TEI warms up for ~30-60s on CPU before it can serve; an empty `items` array
usually just means the worker's sweep has not backfilled yet (every 60s by
default). If `sd-tei-embeddings` dies during startup, it is almost certainly
memory — raise Docker's memory limit (§0) and see signals-dpg's §6.1.

### 10.3 Adding or removing search on a running stack

Use the **same `-f docker-compose.search.yml` for every command** (`ps`,
`logs`, `down`) while search is on — a plain `docker compose …` only sees the
base file and leaves the search containers out. To avoid typing it, put this in
`.env`:

```dotenv
COMPOSE_FILE=docker-compose.search.yml
```

**Add search** to a stack started without it:

```bash
docker compose -f docker-compose.search.yml up -d
```

This starts the three search containers; signals-api picks them up on its next
request. The ingestion worker indexes existing items on start.

**Remove search** again:

```bash
docker compose -f docker-compose.search.yml rm -sf \
  tei-embeddings signals-search-api signals-search-worker
```

signals-api falls back to native discover on its next request. To wipe
everything including the search containers, run
`docker compose -f docker-compose.search.yml down -v`.
