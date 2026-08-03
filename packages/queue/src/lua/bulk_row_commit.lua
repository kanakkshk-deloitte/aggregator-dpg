-- bulk_row_commit.lua
--
-- Atomically commits a single row's outcome inside the bulk-upload pipeline.
-- One Redis round-trip; closes the race between SADD and INCR that would
-- otherwise leave a row counted in `processed` but not in any counter.
--
-- KEYS:
--   KEYS[1] = bu:{id}:processed     (SET of row indices already committed)
--   KEYS[2] = bu:{id}:counters      (HASH: passed | failed | skipped)
--   KEYS[3] = bu:{id}:errors        (HASH: row_index -> JSON {raw_row,reasons,error_category})
--   KEYS[4] = bu:{id}:error_rows    (SET of row indices with errors)
--   KEYS[5] = bu:{id}:meta          (HASH: total_rows | reader_done | started_at)
--
-- ARGV:
--   ARGV[1] = row_index             (integer as string)
--   ARGV[2] = outcome               ("passed" | "failed" | "skipped")
--   ARGV[3] = error_payload_json    (string; "" if outcome == "passed" or "skipped")
--   ARGV[4] = ttl_seconds           (integer as string; TTL refreshed on every
--                                    key so participant PII cannot outlive an
--                                    abandoned/stuck upload. 0/absent = no TTL.)
--
-- Returns:
--   {processed_count, total_rows_or_-1, reader_done_or_0, was_new_or_0}
--   - was_new = 1 if this call committed the row, 0 if it was already committed.
--
-- The worker uses (processed_count, total, reader_done) to decide whether to
-- enqueue the Finaliser. `was_new = 0` means this is a replay; the worker
-- exits early without re-doing the persistence side effect.

local added = redis.call('SADD', KEYS[1], ARGV[1])

if added == 1 then
  -- First time committing this row: increment the right counter.
  redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
  if ARGV[2] ~= 'passed' and ARGV[3] ~= '' then
    redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
    redis.call('SADD', KEYS[4], ARGV[1])
  end
end

-- Refresh the TTL on every key we touch so the whole bu:{id} namespace
-- (incl. the PII-bearing :errors hash) self-expires if this upload is later
-- abandoned or wedged and never reaches the Finaliser's DEL. EXPIRE on a
-- missing key is a harmless no-op (e.g. :errors before any failure).
local ttl = tonumber(ARGV[4])
if ttl and ttl > 0 then
  for i = 1, 5 do
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end

local total = redis.call('HGET', KEYS[5], 'total_rows')
local reader_done = redis.call('HGET', KEYS[5], 'reader_done')
local processed = redis.call('SCARD', KEYS[1])

return {
  processed,
  total and tonumber(total) or -1,
  reader_done == '1' and 1 or 0,
  added,
}
