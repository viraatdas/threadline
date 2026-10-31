-- Outbound rebuild: the read-only relationship-sync model (Gmail/LinkedIn/X
-- history, analysis jobs, sync bookkeeping) is replaced by a small outbound
-- model. Old tables are dropped; take a database snapshot before applying.
DROP TABLE IF EXISTS "analysis_jobs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "analysis_results" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "audit_events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "channel_identities" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "companies" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "contacts" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "conversation_participants" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "conversations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "integration_accounts" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "messages" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "outreach_plans" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "settings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "sync_cursors" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "sync_runs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "touchpoints" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."analysis_job_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."analysis_job_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."audit_outcome";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."channel";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."entity_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."integration_provider";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."integration_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."message_direction";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."outreach_plan_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."participant_role";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."relationship_stage";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."reply_state";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."sync_run_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."sync_trigger";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."touchpoint_kind";--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"angle" text NOT NULL,
	"steps" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"website" text,
	"description" text,
	"location" text,
	"team_size" integer,
	"linkedin_url" text,
	"github_login" text,
	"yc_slug" text,
	"yc_batch" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"score" integer,
	"fit_summary" text,
	"hook" text,
	"researched_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"provider" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_key_version" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"campaign_id" uuid,
	"step" integer,
	"channel" text NOT NULL,
	"direction" text DEFAULT 'out' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"due_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"external_id" text,
	"thread_id" text,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"title" text,
	"email" text,
	"email_status" text,
	"linkedin_url" text,
	"twitter_url" text,
	"location" text,
	"source" text NOT NULL,
	"stage" text DEFAULT 'new' NOT NULL,
	"closed_reason" text,
	"campaign_id" uuid,
	"next_step" integer DEFAULT 0 NOT NULL,
	"next_step_at" timestamp with time zone,
	"last_contacted_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'owner' NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"url" text,
	"strength" integer DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_uidx" ON "companies" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_github_uidx" ON "companies" USING btree ("github_login");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_yc_uidx" ON "companies" USING btree ("yc_slug");--> statement-breakpoint
CREATE INDEX "companies_status_score_idx" ON "companies" USING btree ("status","score");--> statement-breakpoint
CREATE INDEX "messages_status_due_idx" ON "messages" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "messages_person_idx" ON "messages" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_step_uidx" ON "messages" USING btree ("person_id","campaign_id","step") WHERE "messages"."direction" = 'out';--> statement-breakpoint
CREATE UNIQUE INDEX "people_email_uidx" ON "people" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "people_linkedin_uidx" ON "people" USING btree ("linkedin_url");--> statement-breakpoint
CREATE INDEX "people_company_idx" ON "people" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "people_stage_next_idx" ON "people" USING btree ("stage","next_step_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_dedupe_uidx" ON "signals" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "signals_company_idx" ON "signals" USING btree ("company_id");