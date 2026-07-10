# local-setup — unified full-ecosystem local stack

One `docker compose up -d` that brings up **both** DPGs of the Blue Dots /
Signal Stack ecosystem, wired for localhost:

- **aggregator-dpg** (this repo) — portal (web) + API + worker
- **signals-dpg** (upstream, sibling repo) — the Signals Stack backend
- shared infra — Postgres (3 DBs), two Redis, Keycloak, MinIO, Mailpit

👉 **Full walkthrough: [`LOCAL_SETUP.md`](./LOCAL_SETUP.md)** (Track A = all-in-Docker,
Track B = hybrid hot-reload).

## Required layout

The compose builds *both* repos, so it expects them checked out as **siblings**
and is always run **from this directory**:

```
<parent>/
  ├── aggregator-dpg/          (this repo)
  │     └── local-setup/       ← run docker compose from HERE
  └── signals-dpg/             (sibling; built via ../../signals-dpg)
```

## Quick start

```bash
cd aggregator-dpg/local-setup
cp .env.example .env          # then set ADMIN_EMAILS (see LOCAL_SETUP.md §2)
echo "127.0.0.1 keycloak" | sudo tee -a /etc/hosts   # once
docker compose up -d --build
docker compose ps             # wait for keycloak + aggregator-api healthy
```

Portal → http://localhost:3100 · Signals UI → http://localhost:5173 ·
Mailpit → http://localhost:8025 · Keycloak → http://localhost:8080/admin

## Contents

| File | Purpose |
|---|---|
| `docker-compose.yml` | the unified stack (both DPGs + shared infra) |
| `.env.example` | single root env with working dev defaults — copy to `.env` |
| `LOCAL_SETUP.md` | from-scratch setup guide, both run modes, troubleshooting |
| `infra/postgres.Dockerfile` | Postgres 17 + PostGIS + pgvector image |
| `infra/postgres-init/` | creates the `signals` + `keycloak` DBs on first boot |
| `infra/signals-bootstrap.Dockerfile` | one-shot signals migrate + seed tools image |

> This is **local dev only**. The repo-root `../docker-compose.yml` is the
> separate VM/prod nginx+certbot ingress variant for aggregator-dpg alone.
