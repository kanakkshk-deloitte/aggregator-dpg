-- Migration 0018 — additive `profile` payload on both aggregator tables.
--
-- Fields added by a schema revision land in `profile` instead of getting their
-- own column, so the next revision is a JSON-schema edit with no migration.
-- `profile_ref` records WHICH schema variant produced the payload: the schemas
-- "will have a variation from use case to use case" (Vineela, Aggregator Owner
-- Schema!C4), so a row that does not name its own contract cannot be
-- interpreted later.
--
-- Fully additive. Nothing is renamed, moved, or dropped, and consent is
-- untouched — the existing columns stay authoritative for the fields they
-- already hold. Only fields with NO column go into `profile`.
--
-- `profile_ref` is deliberately nullable with no default. NULL means "row
-- written before 0018". A blanket default would mislabel rows: this DB holds a
-- `practitioner` row, which is orange_dot, not blue_dot.

ALTER TABLE "aggregator_orgs"
  ADD COLUMN IF NOT EXISTS "profile"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "profile_ref" text;
--> statement-breakpoint

ALTER TABLE "aggregators"
  ADD COLUMN IF NOT EXISTS "profile"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "profile_ref" text;
--> statement-breakpoint

-- Shape guard, matching the existing jsonb CHECKs on these tables
-- (aggregators_contact_shape_chk, aggregators_locations_array_chk). Wrapped in
-- DO blocks because ADD CONSTRAINT has no IF NOT EXISTS form.
DO $$ BEGIN
  ALTER TABLE "aggregator_orgs" ADD CONSTRAINT "aggregator_orgs_profile_object_chk"
    CHECK (jsonb_typeof("profile") = 'object');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "aggregators" ADD CONSTRAINT "aggregators_profile_object_chk"
    CHECK (jsonb_typeof("profile") = 'object');
EXCEPTION WHEN duplicate_object THEN null; END $$;
