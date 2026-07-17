# @aggregator-dpg/queue

BullMQ wiring (queue names, job types, connection helpers) — see `.claude/rules/base-class-pattern.md`/`interfaces.md` for the general service-package pattern this package does **not** follow (it's wiring/config, not an abstract-class service). This doc covers the one piece of real complexity here: the atomic row-commit script.

## Default job options

`DEFAULT_JOB_OPTS` (`src/index.ts:119-123`): 3 attempts, exponential backoff (1000ms base), completed jobs kept 1h, failed jobs kept 7d. There is no separate dead-letter queue — a job that exhausts its attempts just persists in BullMQ's failed set for 7 days for manual inspection, then ages out.

## `bulk_row_commit.lua` — why a Lua script instead of two Redis calls

Committing one bulk-upload row's outcome needs both a "have I already counted this row" check (`SADD` into a processed-rows set) and an increment of the right outcome counter (`HINCRBY`). Done as two separate Redis round-trips, a worker crash or a BullMQ replay between the two calls could `SADD` the row without incrementing its counter (or vice versa) — the row would be marked processed but never counted, or counted twice on a genuine replay.

`src/lua/bulk_row_commit.lua` closes that race in one atomic round-trip: `SADD` the row index, and **only if it was newly added** (`added == 1`), `HINCRBY` the outcome counter and record the error payload if any. It returns `{processed_count, total_rows, reader_done, was_new}` in one response — the caller uses `was_new = 0` to detect a replay and skip re-doing any persistence side effect, and `(processed_count, total, reader_done)` to decide whether this was the row that completes the batch (triggering the Finaliser).

`lua-loader.ts` loads the script once at module init, computes its SHA1, and calls it via `EVALSHA` (fast path) — falling back to a full `EVAL` on a `NOSCRIPT` error (Redis restarted and flushed its script cache). If you're changing `bulk_row_commit.lua`, remember its SHA1 is derived from file contents at process start — a running worker won't pick up a script edit until it restarts.
