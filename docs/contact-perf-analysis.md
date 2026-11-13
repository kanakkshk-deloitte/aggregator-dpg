# Contact table: performance & complexity analysis

Phase 1 of the user & org management refactor (PR #825, migrations 0025 / 0026)
moved every person's email / phone / name out of `aggregators.contact` and
`aggregator_orgs.owner_email` / `owner_phone` into a dedicated `contact` table
referenced by `contact_id`. This note records what that costs at read and write
time, measured on 2026-10-01.

**Verdict:** negligible cost at real data volumes; one query (`aggregatorStore.list`)
degrades at very large volumes and is fixed by one index.

## Method

- Scratch database on Postgres 17 (local `signals-postgres` container).
- Migrations 0000–0024 applied (legacy schema), then seeded:
  - 1,000 active orgs (distinct owner email + phone);
  - 100,000 coordinators (distinct contact, `company` extra, 25% pending,
    each under one of the orgs, spread `created_at`).
- Every store query benchmarked with `pgbench -c 4 -j 4 -T 8 -M prepared`,
  using SQL shaped like what the stores actually emit (legacy columns vs
  `selectJoined` + `contact-writes.ts` statement sequence).
- Migrations 0025 + 0026 applied to the same data (~155k coordinators after the
  write benchmark), `VACUUM ANALYZE`, re-benchmarked, then `EXPLAIN ANALYZE`
  (single worker) to explain the differences.
- Volumes are far above production; real tables hold hundreds to low thousands
  of rows.

## Reads

Each lookup is now the base row joined to `contact` on its primary key
(`selectJoined` in both Postgres stores).

| Query                                                                       | Legacy          | Contact table   | Notes                                                                                           |
| --------------------------------------------------------------------------- | --------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `aggregatorStore.findById` (every authenticated request, `access-token.ts`) | 0.088 ms        | 0.105 ms        | +1 PK probe on `contact`                                                                        |
| `findByContactEmail` / `findByContactPhone`                                 | ~0.08 ms        | ~0.11 ms        | `contact_id = (SELECT id FROM contact WHERE …)`: two unique-index probes                        |
| `orgStore.findByOwnerEmail` / `findByOwnerPhone`                            | 0.077 ms        | 0.100 ms        | same pattern, via `aggregator_orgs_contact_id_idx`                                              |
| `findByParentOrgId` (org view)                                              | slow (seq scan) | slow (seq scan) | **Pre-existing**: no index on `parent_org_id`; the join adds only one PK probe per child (~100) |
| `aggregatorStore.list` (page of 50, 108k pending)                           | 146 ms          | 572 ms          | **Real regression at scale**, see below                                                         |

### `aggregatorStore.list` regression

- **Legacy plan:** `Limit → Sort (top-N heapsort) → Seq Scan`; only 50 rows are
  kept while sorting.
- **New plan:** the join sits between `Limit` and `Sort`, so Postgres joins every
  pending row first (hash join over the full `contact` table) and then sorts.
  Under parallel workers it can spill to disk (external merge).
- **Only caller:** the pending-registration prune sweep
  (`routes/aggregator-maintenance.ts`, `status=pending`, `updatedBefore`,
  `limit 1000`). It is a background job, not a user-facing screen.
- **At real volumes** (≤ a few thousand rows) both plans finish in about 1 ms.
- **Fixes tried:**

  | Variant                                                       | Time             |
  | ------------------------------------------------------------- | ---------------- |
  | Current join                                                  | 572 ms           |
  | Page in a subquery first, then join                           | 92 ms            |
  | Index `aggregators (status, created_at DESC)`                 | **2 ms**         |
  | Index `aggregators (parent_org_id)` (for `findByParentOrgId`) | 48 ms → **1 ms** |

## Writes

All contact writes run inside the store's own transaction (`db/contact-writes.ts`).

| Operation            | Legacy  | Contact table | Statements                                                                                                                                           |
| -------------------- | ------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create coordinator   | 0.59 ms | 1.10 ms       | 1 → 5: insert contact (`ON CONFLICT (id) DO NOTHING`), set name if empty, `FOR KEY SHARE` hold, insert row, joined read-back                         |
| Change email / phone | 0.80 ms | 1.54 ms       | 1 → 7: lock row, lock old contact `FOR UPDATE`, target-exists check, reference count, re-key contact (FK `ON UPDATE CASCADE`), update row, read-back |
| Delete coordinator   | ~6.7 ms | ~6.7 ms       | Unchanged, plus one `AFTER DELETE` trigger (`contact_gc`): two indexed `NOT EXISTS` checks                                                           |

- Latencies were measured inside the container (no network). In production each
  extra statement adds one DB round trip, still small next to the Keycloak and
  Signals calls in the same request.
- Contact changes are rare (profile edits only). The extra statements are what
  prevent merging two people (`ContactTakenError`) or silently changing a
  contact shared by two roles (`SharedContactError`).
- Locking stays at row level: a short `FOR KEY SHARE` / `FOR UPDATE` on one
  contact row. There is no table-level contention.

## Migration cost

| Step                               | 155k coordinators + 1k orgs | Notes                                                                       |
| ---------------------------------- | --------------------------- | --------------------------------------------------------------------------- |
| 0025 (create, backfill, link)      | 26.9 s                      | ~0.17 ms/row, linear; `statement_timeout` is 300 s (headroom to ~1.5M rows) |
| 0026 (drop legacy, `SET NOT NULL`) | 0.6 s                       |                                                                             |

At real volumes (a few thousand rows) both finish well under a second.
`DROP COLUMN` does not reclaim space until rows are rewritten; autovacuum
handles the dead tuples from the backfill `UPDATE`.

## Complexity

- **Reads:** one join, defined once per store (`selectJoined`). No caller
  outside the stores sees it. The worker reads only `signalstack_org_id` from
  `aggregators`, so it is unaffected.
- **Writes:** all contact logic is in one module (`contact-writes.ts`, two
  functions: `linkContact`, `changeContact`). Routes, the worker and
  `openapi.json` are unchanged.
- **DB objects that remain after 0026:**
  - `contact_id_of()`, used by the id CHECK;
  - `contact_gc()` and its `AFTER DELETE` triggers;
  - FKs with `ON DELETE RESTRICT ON UPDATE CASCADE`.

  0026 drops the 0025 sync triggers.

- **Key size:** `contact_id` is a 64-char hex text key, about 4× a uuid, so
  its indexes are larger. That is trivial at these volumes.

## Recommended follow-up (not in PR #825)

One small migration adding:

```sql
CREATE INDEX IF NOT EXISTS aggregators_status_created_at_idx
  ON aggregators (status, created_at DESC);
CREATE INDEX IF NOT EXISTS aggregators_parent_org_id_idx
  ON aggregators (parent_org_id);
```

The first removes the `list()` regression. The second fixes the pre-existing
seq scan in `findByParentOrgId` (org view).
