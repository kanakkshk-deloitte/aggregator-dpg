-- fix expire-stale-presigns (D6) — at the 0022 shape, bulk uploads still
-- `pending`: a presigned upload URL was issued but no file was ever started,
-- so nothing of them reached the worker or Signals. Marks them `failed` so the
-- coordinator sees a finished upload and can start a new one after the window.
-- No parameters. Counts only.

UPDATE bulk_uploads
   SET status = 'failed', status_reason = 'expired before the user & org migration window'
 WHERE status = 'pending';
