# local-setup — unified full-ecosystem local stack

One `docker compose up -d` that brings up **both** DPGs of the Blue Dots /
Signal Stack ecosystem, wired for localhost:

- **aggregator-dpg** (this repo) — portal (web) + API + worker
- **signals-dpg** (upstream, sibling repo) — the Signals Stack backend
- shared infra — Postgres (3 DBs), two Redis, Keycloak, MinIO, Mailpit
- **signals-search** (optional, `docker-compose.search.yml`) — relevance-ranked
  discover + match scores (search API, ingestion worker, bge-m3 embedder)

👉 **Full walkthrough: [`LOCAL_SETUP.md`](./LOCAL_SETUP.md)** (Track A = all-in-Docker,
Track B = hybrid hot-reload).

## Required layout

The compose builds _both_ repos, so it expects them checked out as **siblings**
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
cp .env.example .env          # then ./gen-secrets.sh (see LOCAL_SETUP.md §2)
# once; safe to re-run
grep -qE '^[[:space:]]*127\.0\.0\.1[[:space:]]+keycloak([[:space:]]|$)' /etc/hosts \
  || sudo sh -c "printf '\n127.0.0.1 keycloak\n' >> /etc/hosts"
docker compose up -d --build
docker compose ps             # wait for keycloak + aggregator-api healthy
```

Portal → http://localhost:3100 · Signals UI → http://localhost:5173 ·
Mailpit → http://localhost:8025 · Keycloak → http://localhost:8080/admin

**With signals-search** (relevance ranking + match scores; Search API on
http://localhost:3110):

```bash
docker compose -f docker-compose.search.yml up -d --build
```

Needs **≈6 GB** of Docker memory (**≥10 GB** with search — the embedder alone wants 3-4 GB) and a
`docker login dhi.io` before the first build — see `LOCAL_SETUP.md` §0–§1.

## Contents

| File                                 | Purpose                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `docker-compose.yml`                 | the unified stack (both DPGs + shared infra), without search              |
| `docker-compose.search.yml`          | the stack WITH signals-search — includes `docker-compose.yml`, adds API, worker, embedder |
| `.env.example`                       | single root env — copy to `.env`, then run `gen-secrets.sh`               |
| `gen-secrets.sh`                     | fills every `CHANGE_ME_*` placeholder in `.env` (incl. the signals-search apikey) |
| `LOCAL_SETUP.md`                     | from-scratch setup guide, both run modes, troubleshooting                 |
| `infra/postgres.Dockerfile`          | Postgres 17 + PostGIS + pgvector image                                    |
| `infra/postgres-init/`               | creates the `signals` + `keycloak` DBs on first boot                      |
| `infra/signals-bootstrap.Dockerfile` | one-shot signals migrate + seed tools image                               |

> This is **local dev only**. The repo-root `../docker-compose.yml` is the
> separate VM/prod nginx+certbot ingress variant for aggregator-dpg alone.
