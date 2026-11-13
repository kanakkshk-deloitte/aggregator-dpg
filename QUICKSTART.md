# Quickstart — Aggregator DPG (one-time local setup)

## TL;DR — 5 steps

```bash
git clone <repo-url> aggregator-dpg && cd aggregator-dpg
pnpm install
pnpm stack:setup                     # bootstraps .env + host entries (or: make setup)
# open .env and set: ADMIN_EMAILS=you@yourorg.com
pnpm stack:up                        # boots the full stack (or: make up)
open http://localhost:3100
```

Done. Full detail below.

Goal: clone → run → working app, with docker only. No `pnpm dev`, no two-terminal hot-reload. For dev mode with hot-reload, see [`SETUP.md`](SETUP.md).

URLs after setup:

| What           | URL                                                |
| -------------- | -------------------------------------------------- |
| Portal (web)   | <http://localhost:3100>                            |
| API            | <http://localhost:4000>                            |
| Keycloak admin | <http://localhost:8080/admin> (`admin` / from env) |
| MailHog inbox  | <http://localhost:8025>                            |
| MinIO console  | <http://localhost:9001>                            |

---

## 0. Prereqs

| Tool                      | Version                                  |
| ------------------------- | ---------------------------------------- |
| Docker + Docker Compose   | recent                                   |
| `make`, `openssl`, `sudo` | any                                      |
| Node.js + pnpm            | only if rebuilding web image after edits |

**Supported hosts:** macOS, Linux, and **native Windows** (Docker Desktop — no WSL2 required). See the Windows note in §3.

---

## 1. Clone + one-shot setup

```bash
git clone <repo-url> aggregator-dpg
cd aggregator-dpg
make setup
```

`make setup` does two things:

1. Copies `infra/env.template` → `.env` (mode 600).
2. Adds `127.0.0.1 keycloak` and `127.0.0.1 minio` to `/etc/hosts` (sudo prompt). Required so browser + web container resolve OIDC issuer to same host.

---

## 2. `.env` — one required edit

`make setup` populated `.env` from `infra/env.local` (pre-filled DEV-ONLY values: Postgres pw, MinIO pw, KC admin pw, OIDC client secrets, `SESSION_KEY`, `APPROVAL_TOKEN_SECRET`).

**Required edit — admin email.** Approval emails for new aggregator registrations are sent to `ADMIN_EMAILS`. Open `.env` and set it to your real address:

```dotenv
ADMIN_EMAILS=you@yourorg.com           # comma-separated for multiple admins
```

Without this, you won't receive the Approve/Reject email and can't complete registration flow.

Optional — SMTP creds. Default ships with Gmail SMTP (Sahamati). To send from your own Gmail, replace `SMTP_USER` / `SMTP_PASSWORD` (use a Gmail App Password, not the account password).

> Production / staging: use `infra/env.template` instead. Replace every `change-me-*` and generate real secrets with `openssl rand -hex 32`. Never use `infra/env.local` values outside localhost.

---

## 3. Bring everything up

```bash
make up        # docker compose up -d --build
make ps        # wait until keycloak shows healthy (60–90s first run)
```

First run pulls ~1.5 GB images, builds web + api + worker. API auto-runs migrations on boot (`RUN_MIGRATIONS_ON_BOOT=true`). Realm + OTP authenticator import from `infra/keycloak/` automatically.

Tail logs if anything looks stuck:

```bash
make logs                            # all services
docker compose logs -f keycloak      # one service
```

### Windows note

`make` is not required on Windows — use the pnpm scripts, which run the same cross-platform `scripts/stack.mjs`:

```powershell
pnpm install
pnpm stack:setup     # creates .env; PRINTS the two host lines to add (see below)
pnpm stack:up        # boots the stack
```

The one manual step on Windows: `pnpm stack:setup` cannot edit the hosts file for you (it needs Administrator). It prints two lines like:

```
127.0.0.1 keycloak
127.0.0.1 minio
```

Open `C:\Windows\System32\drivers\etc\hosts` in Notepad **run as Administrator**, paste those two lines, save, then run `pnpm stack:up`. Re-running `pnpm stack:setup` is safe — it never duplicates entries.

Keycloak OTP-plugin rebuilds (`make kc-plugin` / `make rebuild-keycloak`) and the Helm targets remain Unix/WSL-only; the prebuilt OTP JAR is committed, so a normal Windows run does not need them.

---

## 4. Smoke test

```text
1. http://localhost:3100/register → fill form → submit
2. http://localhost:8025 → find admin email → click Approve → confirm
3. http://localhost:3100/login → sign in (email or phone OTP)
4. Land on portal, profile page renders
```

---

## 5. Common commands

```bash
make ps         # status
make logs       # tail all
make down       # stop (keep volumes)
make reset      # stop + WIPE all data (destructive)
make psql       # open psql shell
make kc         # print KC admin URL
```

Rebuild only web after code change:

```bash
make rebuild-web
```

---

## 6. Troubleshooting

| Symptom                                            | Fix                                                                                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make up` fails: `port already in use`             | Stop local Postgres/Redis or change host port in `docker-compose.yml`.                                                                                                  |
| `keycloak` container restarts                      | Bad `KC_BOOTSTRAP_ADMIN_PASSWORD` or stale volume. `make reset` then `make up`.                                                                                         |
| Browser can't reach <http://keycloak:8080>         | Hosts entry missing. Re-run `make setup` (or `pnpm stack:setup`); on Windows, re-paste the printed lines into `C:\Windows\System32\drivers\etc\hosts` as Administrator. |
| `403 MISSING_AGGREGATOR_ID` on profile             | Realm mappers missing — re-import realm. Verify `infra/keycloak/realms/realm.json` has `aggregator_id` + `phone_number` mappers on `aggregator-portal` client.          |
| Login: "user does not exist" with registered email | KC user has empty email — re-register or edit user in KC admin.                                                                                                         |
| Approval link "Already approved" first click       | Leftover user state. Delete user in KC admin or pick different aggregator id.                                                                                           |
| No mail arrives                                    | Check <http://localhost:8025> first; real SMTP requires `MAIL_PROVIDER=smtp` + creds in `.env`.                                                                         |

---

## 7. Full reset

```bash
make reset       # wipe volumes
make up          # rebuild — realm + mappers re-import automatically
```
