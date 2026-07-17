# CLAUDE.md — apps/worker

Guidance specific to working inside `apps/worker`. Read the root `CLAUDE.md` first for the five jobs (`bulk-file-process`, `bulk-row-process`, `bulk-finalise`, `cron-watchdog`, `link-metrics-rollup`) and the `WORKER_ROLES` split. Two things worth knowing before touching this code:

## `WORKER_ROLES` coverage is a per-process self-check, not a fleet guard

`worker-roles.ts`'s `parseWorkerRoles` fails fast at boot if `WORKER_ROLES` names an unknown role. But the "union across the fleet must cover all four roles or uploads strand" invariant from root `CLAUDE.md` is **only checked within one process**: `main.ts:148-152` calls `missingRoles(roles)` and `logger.warn(..., status: 'partial_roles')` if _this_ process doesn't cover a role — it has no way to know what other pods in the fleet are running, so it can't detect "nobody anywhere is running `row`." Covering the full role set across a deployment is operational discipline, not something the code enforces or can enforce from inside one process.

## `link-metrics-rollup.ts`: the file's own "idempotent, restart-safe" claim is incomplete

The header comment states: _"Idempotent. Restart-safe via `rolled_up_at IS NULL` filter."_ That's true only if the whole rollup (aggregate → upsert-with-increment → mark-rolled-up) completes atomically — **it doesn't**. The per-bucket `onConflictDoUpdate` (`total/passed/failed/skipped += EXCLUDED.*`) and the final `UPDATE ... SET rolled_up_at = NOW()` are separate statements, not wrapped in `db.transaction()` (confirmed: no `.transaction(` call anywhere in this file, unlike `bulk-finalise.ts` which does use one). If the process crashes after some bucket increments commit but before the final mark-rolled-up write, those rows are still `rolled_up_at IS NULL` — the next run re-selects them and **re-increments the same totals a second time**, silently double-counting. If you're touching this file: either wrap steps 3+4 in a transaction, or at minimum don't repeat the "restart-safe" claim elsewhere without this caveat.
