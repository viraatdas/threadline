CREATE TYPE "public"."analysis_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."analysis_job_type" AS ENUM('classify_outreach', 'extract_contact', 'resolve_company', 'summarize_thread', 'detect_reply', 'recommend_follow_up', 'draft_outreach');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'denied', 'failure');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('gmail', 'linkedin', 'x');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('integration_account', 'contact', 'company', 'channel_identity', 'conversation', 'message', 'outreach_plan', 'touchpoint', 'analysis_job', 'analysis_result', 'sync_run', 'setting');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('gmail', 'linkedin', 'x');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('pending', 'connected', 'attention_required', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound', 'system', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."outreach_plan_status" AS ENUM('draft', 'planned', 'active', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."participant_role" AS ENUM('owner', 'contact', 'other');--> statement-breakpoint
CREATE TYPE "public"."relationship_stage" AS ENUM('unreviewed', 'planned', 'active', 'waiting', 'replied', 'dormant', 'closed');--> statement-breakpoint
CREATE TYPE "public"."reply_state" AS ENUM('unknown', 'awaiting_reply', 'replied', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sync_trigger" AS ENUM('manual', 'scheduled', 'webhook', 'backfill');--> statement-breakpoint
CREATE TYPE "public"."touchpoint_kind" AS ENUM('message', 'reply', 'meeting', 'note', 'planned_follow_up', 'draft');--> statement-breakpoint
CREATE TABLE "analysis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"job_type" "analysis_job_type" NOT NULL,
	"status" "analysis_job_status" DEFAULT 'queued' NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"runner" text DEFAULT 'codex-cli' NOT NULL,
	"model" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_jobs_attempt_count_chk" CHECK ("analysis_jobs"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analysis_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"result_type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"result" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"confidence" double precision NOT NULL,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"has_manual_override" boolean DEFAULT false NOT NULL,
	"manual_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manually_overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_results_confidence_chk" CHECK ("analysis_results"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"outcome" "audit_outcome" NOT NULL,
	"actor_email" text NOT NULL,
	"entity_type" "entity_type",
	"entity_id" uuid,
	"request_id" text,
	"ip_hash" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"integration_account_id" uuid,
	"channel" "channel" NOT NULL,
	"external_id" text NOT NULL,
	"handle" text,
	"address" text,
	"display_name" text,
	"profile_url" text,
	"is_owner" boolean DEFAULT false NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_external_id" text,
	"source_url" text,
	"source_collected_at" timestamp with time zone,
	"source_confidence" double precision DEFAULT 1 NOT NULL,
	"source_provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_manual_override" boolean DEFAULT false NOT NULL,
	"manual_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manually_overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_identities_confidence_chk" CHECK ("channel_identities"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"domain" text,
	"website_url" text,
	"linkedin_url" text,
	"industry" text,
	"size_range" text,
	"location" text,
	"description" text,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_external_id" text,
	"source_url" text,
	"source_collected_at" timestamp with time zone,
	"source_confidence" double precision DEFAULT 1 NOT NULL,
	"source_provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_manual_override" boolean DEFAULT false NOT NULL,
	"manual_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manually_overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_confidence_chk" CHECK ("companies"."confidence" between 0 and 1),
	CONSTRAINT "companies_source_confidence_chk" CHECK ("companies"."source_confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"display_name" text NOT NULL,
	"given_name" text,
	"family_name" text,
	"primary_email" text,
	"title" text,
	"seniority" text,
	"location" text,
	"relationship_stage" "relationship_stage" DEFAULT 'unreviewed' NOT NULL,
	"reply_state" "reply_state" DEFAULT 'unknown' NOT NULL,
	"first_touch_at" timestamp with time zone,
	"last_touch_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"planned_follow_up_at" timestamp with time zone,
	"touch_count" integer DEFAULT 0 NOT NULL,
	"inbound_touch_count" integer DEFAULT 0 NOT NULL,
	"outbound_touch_count" integer DEFAULT 0 NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_external_id" text,
	"source_url" text,
	"source_collected_at" timestamp with time zone,
	"source_confidence" double precision DEFAULT 1 NOT NULL,
	"source_provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_manual_override" boolean DEFAULT false NOT NULL,
	"manual_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manually_overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_touch_count_chk" CHECK ("contacts"."touch_count" >= 0),
	CONSTRAINT "contacts_inbound_count_chk" CHECK ("contacts"."inbound_touch_count" >= 0),
	CONSTRAINT "contacts_outbound_count_chk" CHECK ("contacts"."outbound_touch_count" >= 0),
	CONSTRAINT "contacts_confidence_chk" CHECK ("contacts"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"conversation_id" uuid NOT NULL,
	"channel_identity_id" uuid,
	"contact_id" uuid,
	"external_participant_id" text NOT NULL,
	"role" "participant_role" DEFAULT 'other' NOT NULL,
	"display_name" text,
	"address" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_participants_conversation_id_external_participant_id_pk" PRIMARY KEY("conversation_id","external_participant_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"external_conversation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"subject" text,
	"preview" text,
	"first_message_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"touch_count" integer DEFAULT 0 NOT NULL,
	"reply_state" "reply_state" DEFAULT 'unknown' NOT NULL,
	"is_customer_outreach" boolean,
	"outreach_confidence" double precision DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_external_id" text,
	"source_url" text,
	"source_collected_at" timestamp with time zone,
	"source_confidence" double precision DEFAULT 1 NOT NULL,
	"source_provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_manual_override" boolean DEFAULT false NOT NULL,
	"manual_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manually_overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_touch_count_chk" CHECK ("conversations"."touch_count" >= 0),
	CONSTRAINT "conversations_outreach_confidence_chk" CHECK ("conversations"."outreach_confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "integration_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"account_email" text,
	"status" "integration_status" DEFAULT 'pending' NOT NULL,
	"sync_enabled" boolean DEFAULT true NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_key_version" integer DEFAULT 1 NOT NULL,
	"connected_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_accounts_read_only_chk" CHECK ("integration_accounts"."read_only" = true)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"sender_identity_id" uuid,
	"reply_to_message_id" uuid,
	"channel" "channel" NOT NULL,
	"external_message_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"direction" "message_direction" DEFAULT 'unknown' NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone,
	"subject" text,
	"body_text" text,
	"body_html" text,
	"snippet" text,
	"content_hash" text,
	"has_reply" boolean DEFAULT false NOT NULL,
	"reply_received_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_external_id" text,
	"source_url" text,
	"source_collected_at" timestamp with time zone,
	"source_confidence" double precision DEFAULT 1 NOT NULL,
	"source_provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_manual_override" boolean DEFAULT false NOT NULL,
	"manual_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manually_overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid,
	"status" "outreach_plan_status" DEFAULT 'draft' NOT NULL,
	"objective" text NOT NULL,
	"preferred_channels" "channel"[] DEFAULT '{}'::channel[] NOT NULL,
	"next_touch_at" timestamp with time zone,
	"cadence_interval_days" integer,
	"planned_touch_count" integer DEFAULT 1 NOT NULL,
	"completed_touch_count" integer DEFAULT 0 NOT NULL,
	"first_touch_at" timestamp with time zone,
	"last_touch_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"suggested_draft" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"has_manual_override" boolean DEFAULT false NOT NULL,
	"manual_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manually_overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_plans_planned_count_chk" CHECK ("outreach_plans"."planned_touch_count" >= 0),
	CONSTRAINT "outreach_plans_completed_count_chk" CHECK ("outreach_plans"."completed_touch_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"value" jsonb,
	"encrypted_value" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"description" text,
	"has_manual_override" boolean DEFAULT false NOT NULL,
	"manual_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manually_overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_secret_storage_chk" CHECK (("settings"."is_secret" = false and "settings"."encrypted_value" is null) or ("settings"."is_secret" = true and "settings"."value" is null and "settings"."encrypted_value" is not null))
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"cursor_ciphertext" text NOT NULL,
	"cursor_key_version" integer DEFAULT 1 NOT NULL,
	"last_seen_external_id" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"resource" text NOT NULL,
	"trigger" "sync_trigger" DEFAULT 'scheduled' NOT NULL,
	"status" "sync_run_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cursor_before_ciphertext" text,
	"cursor_after_ciphertext" text,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_runs_discovered_count_chk" CHECK ("sync_runs"."discovered_count" >= 0),
	CONSTRAINT "sync_runs_inserted_count_chk" CHECK ("sync_runs"."inserted_count" >= 0),
	CONSTRAINT "sync_runs_updated_count_chk" CHECK ("sync_runs"."updated_count" >= 0),
	CONSTRAINT "sync_runs_skipped_count_chk" CHECK ("sync_runs"."skipped_count" >= 0),
	CONSTRAINT "sync_runs_failed_count_chk" CHECK ("sync_runs"."failed_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "touchpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid,
	"conversation_id" uuid,
	"message_id" uuid,
	"outreach_plan_id" uuid,
	"integration_account_id" uuid,
	"idempotency_key" text NOT NULL,
	"channel" "channel",
	"direction" "message_direction" DEFAULT 'unknown' NOT NULL,
	"kind" "touchpoint_kind" NOT NULL,
	"reply_state" "reply_state" DEFAULT 'unknown' NOT NULL,
	"happened_at" timestamp with time zone NOT NULL,
	"is_automated" boolean DEFAULT true NOT NULL,
	"summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_external_id" text,
	"source_url" text,
	"source_collected_at" timestamp with time zone,
	"source_confidence" double precision DEFAULT 1 NOT NULL,
	"source_provenance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_manual_override" boolean DEFAULT false NOT NULL,
	"manual_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manually_overridden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_job_id_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."analysis_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_channel_identity_id_channel_identities_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_identity_id_channel_identities_id_fk" FOREIGN KEY ("sender_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_plans" ADD CONSTRAINT "outreach_plans_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_plans" ADD CONSTRAINT "outreach_plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_outreach_plan_id_outreach_plans_id_fk" FOREIGN KEY ("outreach_plan_id") REFERENCES "public"."outreach_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "touchpoints" ADD CONSTRAINT "touchpoints_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_jobs_idempotency_uidx" ON "analysis_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "analysis_jobs_queue_idx" ON "analysis_jobs" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "analysis_jobs_entity_idx" ON "analysis_jobs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_results_job_type_uidx" ON "analysis_results" USING btree ("job_id","result_type");--> statement-breakpoint
CREATE INDEX "analysis_results_entity_idx" ON "analysis_results" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_email","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_account_external_uidx" ON "channel_identities" USING btree ("integration_account_id","channel","external_id");--> statement-breakpoint
CREATE INDEX "channel_identities_contact_idx" ON "channel_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "channel_identities_address_idx" ON "channel_identities" USING btree ("channel","address");--> statement-breakpoint
CREATE INDEX "companies_normalized_name_idx" ON "companies" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_uidx" ON "companies" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_primary_email_idx" ON "contacts" USING btree ("primary_email");--> statement-breakpoint
CREATE INDEX "contacts_last_touch_idx" ON "contacts" USING btree ("last_touch_at");--> statement-breakpoint
CREATE INDEX "contacts_follow_up_idx" ON "contacts" USING btree ("planned_follow_up_at");--> statement-breakpoint
CREATE INDEX "contacts_reply_state_idx" ON "contacts" USING btree ("reply_state");--> statement-breakpoint
CREATE INDEX "conversation_participants_contact_idx" ON "conversation_participants" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversation_participants_identity_idx" ON "conversation_participants" USING btree ("channel_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_account_external_uidx" ON "conversations" USING btree ("integration_account_id","external_conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_idempotency_uidx" ON "conversations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "conversations_last_message_idx" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_reply_state_idx" ON "conversations" USING btree ("reply_state");--> statement-breakpoint
CREATE INDEX "conversations_outreach_idx" ON "conversations" USING btree ("is_customer_outreach");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_accounts_provider_external_uidx" ON "integration_accounts" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE INDEX "integration_accounts_status_idx" ON "integration_accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_external_uidx" ON "messages" USING btree ("integration_account_id","external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_uidx" ON "messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "messages_conversation_sent_idx" ON "messages" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_direction_sent_idx" ON "messages" USING btree ("direction","sent_at");--> statement-breakpoint
CREATE INDEX "messages_has_reply_idx" ON "messages" USING btree ("has_reply");--> statement-breakpoint
CREATE INDEX "outreach_plans_contact_idx" ON "outreach_plans" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "outreach_plans_next_touch_idx" ON "outreach_plans" USING btree ("status","next_touch_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_uidx" ON "settings" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_cursors_account_resource_uidx" ON "sync_cursors" USING btree ("integration_account_id","resource");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_runs_idempotency_uidx" ON "sync_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "sync_runs_account_started_idx" ON "sync_runs" USING btree ("integration_account_id","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "touchpoints_idempotency_uidx" ON "touchpoints" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "touchpoints_contact_time_idx" ON "touchpoints" USING btree ("contact_id","happened_at");--> statement-breakpoint
CREATE INDEX "touchpoints_plan_time_idx" ON "touchpoints" USING btree ("outreach_plan_id","happened_at");