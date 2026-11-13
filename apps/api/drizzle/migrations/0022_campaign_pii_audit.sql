CREATE TYPE "public"."campaign_audit_event" AS ENUM('requested', 'completed');--> statement-breakpoint
CREATE TYPE "public"."campaign_audit_channel" AS ENUM('export', 'email', 'voice', 'dump');--> statement-breakpoint
CREATE TYPE "public"."campaign_audit_outcome" AS ENUM('succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "campaign_pii_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correlation_id" uuid NOT NULL,
	"event" "campaign_audit_event" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_org_id" text,
	"actor_azp" text,
	"recipient_ref" text,
	"channel" "campaign_audit_channel" NOT NULL,
	"pii_fields" text[],
	"item_count" integer,
	"requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"destination" text,
	"network" text,
	"instance" text,
	"request_ip" text,
	"purpose" text,
	"consent_ref" text,
	"endpoint" text,
	"trace_id" text,
	"outcome" "campaign_audit_outcome",
	"error_code" text,
	"requested_count" integer,
	"resolved_count" integer,
	"skipped_count" integer,
	"failed_count" integer,
	"sent_count" integer,
	"details" jsonb
);--> statement-breakpoint
CREATE INDEX "campaign_pii_audit_org_created_idx" ON "campaign_pii_audit" USING btree ("actor_org_id","created_at");--> statement-breakpoint
CREATE INDEX "campaign_pii_audit_correlation_idx" ON "campaign_pii_audit" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "campaign_pii_audit_channel_created_idx" ON "campaign_pii_audit" USING btree ("channel","created_at");
