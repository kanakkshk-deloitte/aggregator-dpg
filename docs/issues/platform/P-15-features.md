# P-15 Security baseline — features

---

## F-15.1 TLS/HSTS baseline

**AC**

- [x] All public routes served over TLS; HTTP→HTTPS redirect at ingress
- [x] HSTS header with `max-age=31536000; includeSubDomains; preload` in prod (note: shipped at `max-age=31536000`/1y per the security-remediation plan's acceptance criteria, not the `63072000`/2y originally noted here — reconcile if 2y is still wanted)
- [ ] Ops doc records certificate source + rotation

**Tasks**

- [x] T-15.1.1 Ingress config (template) — `infra/nginx/templates/aggregator.conf.template` now sends `Strict-Transport-Security` on the TLS server block
- [ ] T-15.1.2 HSTS middleware in `apps/api` — not needed today since the nginx edge is the only ingress point; revisit if `apps/api` is ever exposed directly
- [ ] T-15.1.3 Ops doc

---

## F-15.2 CSRF on state-changing endpoints

**AC**

- [ ] Decision: MVP uses bearer JWT (no cookies) — CSRF not required for API
- [ ] If cookies are ever used, a CSRF middleware using double-submit pattern is documented + flagged on per-route
- [ ] ADR captured

**Tasks**

- [ ] T-15.2.1 ADR: CSRF stance
- [ ] T-15.2.2 CSRF middleware (dormant, flag-gated)

---

## F-15.3 CSP headers

**AC**

- [ ] `apps/web` sends CSP: `default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline' (dev only)`; tightened in prod
- [ ] Violations reported to `POST /v1/csp-report` (logged only in MVP)

**Tasks**

- [ ] T-15.3.1 Next.js middleware
- [ ] T-15.3.2 Violation endpoint

---

## F-15.4 CSV virus scan + MIME/size limits

**AC**

- [ ] Upload size ≤ 25 MB; MIME must be `text/csv` or `application/vnd.ms-excel`
- [ ] ClamAV scan on upload (or equivalent); infected files rejected with typed error
- [ ] Streaming parse — never load the full file into memory

**Tasks**

- [ ] T-15.4.1 Multipart handler with limits
- [ ] T-15.4.2 ClamAV integration (config-gated for dev)
- [ ] T-15.4.3 Streaming parser wrapper

---

## F-15.5 Signed URL TTL conventions

**AC**

- [ ] Export download signed URLs default 1 h, max 4 h
- [ ] Signed URLs never logged; only their keys

**Tasks**

- [ ] T-15.5.1 Convention doc
- [ ] T-15.5.2 Log redaction test

---

## F-15.6 Secrets management

**AC**

- [ ] `.env.example` lists every expected env var with non-secret placeholder
- [ ] CI scans for committed secrets (gitleaks); blocks PR on detection
- [ ] Prod secrets loaded from a secret store (Vault / SSM / KMS — ops choice)

**Tasks**

- [ ] T-15.6.1 `.env.example`
- [ ] T-15.6.2 gitleaks CI job
- [ ] T-15.6.3 Secret store integration doc (ADR)
