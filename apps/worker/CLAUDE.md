# CLAUDE.md — apps/worker

Guidance specific to working inside `apps/worker`. Read the root `CLAUDE.md` first for the six jobs (`bulk-file-process`, `bulk-row-process`, `bulk-finalise`, `cron-watchdog`, `link-metrics-rollup`, `campaign-process`) and the `WORKER_ROLES` split. A few things worth knowing before touching this code:

## `WORKER_ROLES` coverage is a per-process self-check, not a fleet guard

`worker-roles.ts`'s `parseWorkerRoles` fails fast at boot if `WORKER_ROLES` names an unknown role — the roles are `file,row,finalise,cron,campaign` (`cron` covers both `link-metrics-rollup` and `cron-watchdog`; `campaign` covers the `campaign-process` pipeline). But the "union across the fleet must cover all five roles or work strands" invariant from root `CLAUDE.md` is **only checked within one process**: `missingRoles(roles)` logs `logger.warn(..., status: 'partial_roles')` if _this_ process doesn't cover a role — it has no way to know what other pods in the fleet are running, so it can't detect "nobody anywhere is running `row`." Covering the full role set across a deployment is operational discipline, not something the code enforces or can enforce from inside one process.

## `/healthz` is liveness-only — it never fails on an unreachable Redis

`health.ts` (#675) serves a `/healthz` liveness endpoint that answers the single question "would a restart help?". It **always** returns `200` when the process can respond at all — a blocked event loop simply fails to answer and the kubelet restarts on the probe timeout, which is the case a restart actually fixes. A dead Redis is deliberately **not** treated as unhealthy: restarting can't bring Redis back, so failing the probe would CrashLoopBackOff every replica through an outage. Instead the body reports `status: "degraded"`, `redis: "unreachable"` (still `200`) so alerting can see it without the kubelet acting on it. Don't wire a readiness-style hard-fail into this endpoint.

## `link-metrics-rollup.ts`: the file's own "idempotent, restart-safe" claim is incomplete

The header comment states: _"Idempotent. Restart-safe via `rolled_up_at IS NULL` filter."_ That's true only if the whole rollup (aggregate → upsert-with-increment → mark-rolled-up) completes atomically — **it doesn't**. The per-bucket `onConflictDoUpdate` (`total/passed/failed/skipped += EXCLUDED.*`) and the final `UPDATE ... SET rolled_up_at = NOW()` are separate statements, not wrapped in `db.transaction()` (confirmed: no `.transaction(` call anywhere in this file, unlike `bulk-finalise.ts` which does use one). If the process crashes after some bucket increments commit but before the final mark-rolled-up write, those rows are still `rolled_up_at IS NULL` — the next run re-selects them and **re-increments the same totals a second time**, silently double-counting. If you're touching this file: either wrap steps 3+4 in a transaction, or at minimum don't repeat the "restart-safe" claim elsewhere without this caveat.

## Bulk `bu:{id}:*` working keys carry a TTL so PII self-expires

The bulk-upload working keys (`bu:{id}:lines` = each uploaded row's cells as a JSON array — the Finaliser rebuilds errors.csv from them without re-parsing CSV, falling back to a `,`-split for a CSV line left by the previous release, `bu:{id}:errors` = per-row errors including PII) carry `BULK_UPLOAD_REDIS_TTL_SECONDS` (default 24h), refreshed on each row-commit so the PII self-expires as a backstop. The stuck-job watchdog also deletes these keys on failure. Pino loggers redact `email` / `phone` (plus secrets), so PII never lands in logs.
