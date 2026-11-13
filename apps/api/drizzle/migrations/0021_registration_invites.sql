-- Migration 0021 — registration_invites (targeted coordinator invites, #700).
--
-- Additive + inert when ORG_HIERARCHY_ENABLED=false: the table stays empty and
-- nothing writes to it. A row backs single-use, revocation, and leak
-- attribution for email-bound invites — the approval-token re-check trick is
-- unavailable here because an invitee has no Keycloak user yet. The invite
-- JWT's `sub` is this row's `jti`. FK → aggregator_orgs (cascade).

DO $$ BEGIN
  CREATE TYPE "registration_invite_status" AS ENUM ('pending', 'consumed', 'revoked', 'expired');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "registration_invites" (
  "jti" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "role" text DEFAULT 'coordinator' NOT NULL,
  "parent_org_id" uuid NOT NULL,
  "email" text NOT NULL,
  "status" "registration_invite_status" DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "registration_invites"
    ADD CONSTRAINT "registration_invites_parent_org_id_aggregator_orgs_id_fk"
    FOREIGN KEY ("parent_org_id") REFERENCES "aggregator_orgs"("id") ON DELETE cascade;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "registration_invites_parent_org_idx"
  ON "registration_invites" ("parent_org_id");

-- One live invite per (org, email): re-inviting refreshes rather than
-- duplicates. Partial unique over pending rows only.
CREATE UNIQUE INDEX IF NOT EXISTS "registration_invites_pending_unique"
  ON "registration_invites" ("parent_org_id", "email") WHERE "status" = 'pending';

-- aggregators.invite_email (#701): the email a coordinator was INVITED at, kept
-- for provenance when they register with a different address (they may). May
-- differ from contact_email; surfaced to the approving owner. Additive/nullable.
ALTER TABLE "aggregators" ADD COLUMN IF NOT EXISTS "invite_email" text;

-- rejected_at cooling window (#726): write-once timestamp of rejection on both
-- registration tables. Set exactly once when a pending registration is rejected
-- (status → inactive); never mutated after. Powers the re-registration cooling
-- window without depending on the mutable updated_at. Additive + nullable.
ALTER TABLE "aggregators" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp with time zone;
ALTER TABLE "aggregator_orgs" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp with time zone;
