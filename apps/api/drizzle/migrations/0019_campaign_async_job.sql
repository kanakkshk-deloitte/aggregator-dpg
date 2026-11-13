CREATE TYPE "public"."campaign_channel" AS ENUM('export', 'email', 'voice');--> statement-breakpoint
CREATE TYPE "public"."campaign_job_item_status" AS ENUM('pending', 'resolved', 'submitted', 'sent', 'skipped_not_owned', 'skipped_no_contact', 'duplicate_active', 'failed');--> statement-breakpoint
CREATE TYPE "public"."campaign_job_status" AS ENUM('queued', 'processing', 'partial', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "campaign_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"signalstack_org_id" text NOT NULL,
	"channel" "campaign_channel" NOT NULL,
	"status" "campaign_job_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text,
	"metadata" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"request_id" text,
	"error_reason" text,
	"last_progress_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaign_job_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"channel" "campaign_channel" NOT NULL,
	"item_id" uuid NOT NULL,
	"action" text,
	"status" "campaign_job_item_status" DEFAULT 'pending' NOT NULL,
	"provider_ref" text,
	"raya_batch_id" text,
	"last_provider_status" text,
	"skip_reason" text,
	"error_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "campaign_job" ADD CONSTRAINT "campaign_job_aggregator_id_aggregators_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_job_item" ADD CONSTRAINT "campaign_job_item_job_id_campaign_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."campaign_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_job_idempotency_key_unique" ON "campaign_job" USING btree ("signalstack_org_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_job_org_status_idx" ON "campaign_job" USING btree ("signalstack_org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "campaign_job_status_progress_idx" ON "campaign_job" USING btree ("status","last_progress_at");--> statement-breakpoint
CREATE INDEX "campaign_job_item_job_status_idx" ON "campaign_job_item" USING btree ("job_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_job_item_job_item_unique" ON "campaign_job_item" USING btree ("job_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_job_item_active_dedup" ON "campaign_job_item" USING btree ("item_id","action") WHERE status IN ('pending','resolved','submitted') AND action IS NOT NULL;
