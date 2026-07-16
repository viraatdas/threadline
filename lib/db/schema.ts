import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  ANALYSIS_JOB_STATUS_VALUES,
  ANALYSIS_JOB_TYPE_VALUES,
  AUDIT_OUTCOME_VALUES,
  CHANNEL_VALUES,
  ENTITY_TYPE_VALUES,
  INTEGRATION_PROVIDER_VALUES,
  INTEGRATION_STATUS_VALUES,
  MESSAGE_DIRECTION_VALUES,
  OUTREACH_PLAN_STATUS_VALUES,
  PARTICIPANT_ROLE_VALUES,
  RELATIONSHIP_STAGE_VALUES,
  REPLY_STATE_VALUES,
  SYNC_RUN_STATUS_VALUES,
  SYNC_TRIGGER_VALUES,
  TOUCHPOINT_KIND_VALUES,
} from "@/lib/domain/constants";
import type { ManualOverride, SourceProvenance } from "@/lib/domain/schemas";

type JsonObject = Record<string, unknown>;

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

const sourceColumns = {
  sourceExternalId: text("source_external_id"),
  sourceUrl: text("source_url"),
  sourceCollectedAt: timestamp("source_collected_at", { withTimezone: true }),
  sourceConfidence: doublePrecision("source_confidence").default(1).notNull(),
  sourceProvenance: jsonb("source_provenance")
    .$type<SourceProvenance[]>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
};

const overrideColumns = {
  hasManualOverride: boolean("has_manual_override").default(false).notNull(),
  manualOverrides: jsonb("manual_overrides")
    .$type<ManualOverride[]>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
  manuallyOverriddenAt: timestamp("manually_overridden_at", { withTimezone: true }),
};

export const integrationProviderEnum = pgEnum(
  "integration_provider",
  INTEGRATION_PROVIDER_VALUES,
);
export const integrationStatusEnum = pgEnum("integration_status", INTEGRATION_STATUS_VALUES);
export const channelEnum = pgEnum("channel", CHANNEL_VALUES);
export const messageDirectionEnum = pgEnum("message_direction", MESSAGE_DIRECTION_VALUES);
export const replyStateEnum = pgEnum("reply_state", REPLY_STATE_VALUES);
export const relationshipStageEnum = pgEnum(
  "relationship_stage",
  RELATIONSHIP_STAGE_VALUES,
);
export const participantRoleEnum = pgEnum("participant_role", PARTICIPANT_ROLE_VALUES);
export const outreachPlanStatusEnum = pgEnum(
  "outreach_plan_status",
  OUTREACH_PLAN_STATUS_VALUES,
);
export const touchpointKindEnum = pgEnum("touchpoint_kind", TOUCHPOINT_KIND_VALUES);
export const analysisJobStatusEnum = pgEnum(
  "analysis_job_status",
  ANALYSIS_JOB_STATUS_VALUES,
);
export const analysisJobTypeEnum = pgEnum("analysis_job_type", ANALYSIS_JOB_TYPE_VALUES);
export const syncRunStatusEnum = pgEnum("sync_run_status", SYNC_RUN_STATUS_VALUES);
export const syncTriggerEnum = pgEnum("sync_trigger", SYNC_TRIGGER_VALUES);
export const auditOutcomeEnum = pgEnum("audit_outcome", AUDIT_OUTCOME_VALUES);
export const entityTypeEnum = pgEnum("entity_type", ENTITY_TYPE_VALUES);

export const integrationAccounts = pgTable(
  "integration_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: integrationProviderEnum("provider").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name").notNull(),
    accountEmail: text("account_email"),
    status: integrationStatusEnum("status").default("pending").notNull(),
    syncEnabled: boolean("sync_enabled").default(true).notNull(),
    readOnly: boolean("read_only").default(true).notNull(),
    scopes: text("scopes").array().default(sql`'{}'::text[]`).notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    credentialKeyVersion: integer("credential_key_version").default(1).notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("integration_accounts_provider_external_uidx").on(
      table.provider,
      table.externalAccountId,
    ),
    index("integration_accounts_status_idx").on(table.status),
    check("integration_accounts_read_only_chk", sql`${table.readOnly} = true`),
  ],
);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    domain: text("domain"),
    websiteUrl: text("website_url"),
    linkedinUrl: text("linkedin_url"),
    industry: text("industry"),
    sizeRange: text("size_range"),
    location: text("location"),
    description: text("description"),
    confidence: doublePrecision("confidence").default(0).notNull(),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...sourceColumns,
    ...overrideColumns,
    ...timestamps,
  },
  (table) => [
    index("companies_normalized_name_idx").on(table.normalizedName),
    uniqueIndex("companies_domain_uidx").on(table.domain),
    check("companies_confidence_chk", sql`${table.confidence} between 0 and 1`),
    check(
      "companies_source_confidence_chk",
      sql`${table.sourceConfidence} between 0 and 1`,
    ),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    givenName: text("given_name"),
    familyName: text("family_name"),
    primaryEmail: text("primary_email"),
    title: text("title"),
    seniority: text("seniority"),
    location: text("location"),
    relationshipStage: relationshipStageEnum("relationship_stage")
      .default("unreviewed")
      .notNull(),
    replyState: replyStateEnum("reply_state").default("unknown").notNull(),
    firstTouchAt: timestamp("first_touch_at", { withTimezone: true }),
    lastTouchAt: timestamp("last_touch_at", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    plannedFollowUpAt: timestamp("planned_follow_up_at", { withTimezone: true }),
    touchCount: integer("touch_count").default(0).notNull(),
    inboundTouchCount: integer("inbound_touch_count").default(0).notNull(),
    outboundTouchCount: integer("outbound_touch_count").default(0).notNull(),
    confidence: doublePrecision("confidence").default(0).notNull(),
    notes: text("notes"),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...sourceColumns,
    ...overrideColumns,
    ...timestamps,
  },
  (table) => [
    index("contacts_company_idx").on(table.companyId),
    index("contacts_primary_email_idx").on(table.primaryEmail),
    index("contacts_last_touch_idx").on(table.lastTouchAt),
    index("contacts_follow_up_idx").on(table.plannedFollowUpAt),
    index("contacts_reply_state_idx").on(table.replyState),
    check("contacts_touch_count_chk", sql`${table.touchCount} >= 0`),
    check("contacts_inbound_count_chk", sql`${table.inboundTouchCount} >= 0`),
    check("contacts_outbound_count_chk", sql`${table.outboundTouchCount} >= 0`),
    check("contacts_confidence_chk", sql`${table.confidence} between 0 and 1`),
  ],
);

export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    integrationAccountId: uuid("integration_account_id").references(
      () => integrationAccounts.id,
      { onDelete: "cascade" },
    ),
    channel: channelEnum("channel").notNull(),
    externalId: text("external_id").notNull(),
    handle: text("handle"),
    address: text("address"),
    displayName: text("display_name"),
    profileUrl: text("profile_url"),
    isOwner: boolean("is_owner").default(false).notNull(),
    confidence: doublePrecision("confidence").default(1).notNull(),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...sourceColumns,
    ...overrideColumns,
    ...timestamps,
  },
  (table) => [
    uniqueIndex("channel_identities_account_external_uidx").on(
      table.integrationAccountId,
      table.channel,
      table.externalId,
    ),
    index("channel_identities_contact_idx").on(table.contactId),
    index("channel_identities_address_idx").on(table.channel, table.address),
    check("channel_identities_confidence_chk", sql`${table.confidence} between 0 and 1`),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    integrationAccountId: uuid("integration_account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    externalConversationId: text("external_conversation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    subject: text("subject"),
    preview: text("preview"),
    firstMessageAt: timestamp("first_message_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    touchCount: integer("touch_count").default(0).notNull(),
    replyState: replyStateEnum("reply_state").default("unknown").notNull(),
    isCustomerOutreach: boolean("is_customer_outreach"),
    outreachConfidence: doublePrecision("outreach_confidence").default(0).notNull(),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...sourceColumns,
    ...overrideColumns,
    ...timestamps,
  },
  (table) => [
    uniqueIndex("conversations_account_external_uidx").on(
      table.integrationAccountId,
      table.externalConversationId,
    ),
    uniqueIndex("conversations_idempotency_uidx").on(table.idempotencyKey),
    index("conversations_last_message_idx").on(table.lastMessageAt),
    index("conversations_reply_state_idx").on(table.replyState),
    index("conversations_outreach_idx").on(table.isCustomerOutreach),
    check("conversations_touch_count_chk", sql`${table.touchCount} >= 0`),
    check(
      "conversations_outreach_confidence_chk",
      sql`${table.outreachConfidence} between 0 and 1`,
    ),
  ],
);

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    channelIdentityId: uuid("channel_identity_id").references(() => channelIdentities.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    externalParticipantId: text("external_participant_id").notNull(),
    role: participantRoleEnum("role").default("other").notNull(),
    displayName: text("display_name"),
    address: text("address"),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.externalParticipantId] }),
    index("conversation_participants_contact_idx").on(table.contactId),
    index("conversation_participants_identity_idx").on(table.channelIdentityId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    integrationAccountId: uuid("integration_account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    senderIdentityId: uuid("sender_identity_id").references(() => channelIdentities.id, {
      onDelete: "set null",
    }),
    replyToMessageId: uuid("reply_to_message_id"),
    channel: channelEnum("channel").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    direction: messageDirectionEnum("direction").default("unknown").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    subject: text("subject"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    snippet: text("snippet"),
    contentHash: text("content_hash"),
    hasReply: boolean("has_reply").default(false).notNull(),
    replyReceivedAt: timestamp("reply_received_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...sourceColumns,
    ...overrideColumns,
    ...timestamps,
  },
  (table) => [
    uniqueIndex("messages_account_external_uidx").on(
      table.integrationAccountId,
      table.externalMessageId,
    ),
    uniqueIndex("messages_idempotency_uidx").on(table.idempotencyKey),
    index("messages_conversation_sent_idx").on(table.conversationId, table.sentAt),
    index("messages_direction_sent_idx").on(table.direction, table.sentAt),
    index("messages_has_reply_idx").on(table.hasReply),
  ],
);

export const outreachPlans = pgTable(
  "outreach_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    status: outreachPlanStatusEnum("status").default("draft").notNull(),
    objective: text("objective").notNull(),
    preferredChannels: channelEnum("preferred_channels")
      .array()
      .default(sql`'{}'::channel[]`)
      .notNull(),
    nextTouchAt: timestamp("next_touch_at", { withTimezone: true }),
    cadenceIntervalDays: integer("cadence_interval_days"),
    plannedTouchCount: integer("planned_touch_count").default(1).notNull(),
    completedTouchCount: integer("completed_touch_count").default(0).notNull(),
    firstTouchAt: timestamp("first_touch_at", { withTimezone: true }),
    lastTouchAt: timestamp("last_touch_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    suggestedDraft: text("suggested_draft"),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...overrideColumns,
    ...timestamps,
  },
  (table) => [
    index("outreach_plans_contact_idx").on(table.contactId),
    index("outreach_plans_next_touch_idx").on(table.status, table.nextTouchAt),
    check("outreach_plans_planned_count_chk", sql`${table.plannedTouchCount} >= 0`),
    check("outreach_plans_completed_count_chk", sql`${table.completedTouchCount} >= 0`),
  ],
);

export const touchpoints = pgTable(
  "touchpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    outreachPlanId: uuid("outreach_plan_id").references(() => outreachPlans.id, {
      onDelete: "set null",
    }),
    integrationAccountId: uuid("integration_account_id").references(
      () => integrationAccounts.id,
      { onDelete: "set null" },
    ),
    idempotencyKey: text("idempotency_key").notNull(),
    channel: channelEnum("channel"),
    direction: messageDirectionEnum("direction").default("unknown").notNull(),
    kind: touchpointKindEnum("kind").notNull(),
    replyState: replyStateEnum("reply_state").default("unknown").notNull(),
    happenedAt: timestamp("happened_at", { withTimezone: true }).notNull(),
    isAutomated: boolean("is_automated").default(true).notNull(),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...sourceColumns,
    ...overrideColumns,
    ...timestamps,
  },
  (table) => [
    uniqueIndex("touchpoints_idempotency_uidx").on(table.idempotencyKey),
    index("touchpoints_contact_time_idx").on(table.contactId, table.happenedAt),
    index("touchpoints_plan_time_idx").on(table.outreachPlanId, table.happenedAt),
  ],
);

export const analysisJobs = pgTable(
  "analysis_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    jobType: analysisJobTypeEnum("job_type").notNull(),
    status: analysisJobStatusEnum("status").default("queued").notNull(),
    entityType: entityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    inputHash: text("input_hash").notNull(),
    runner: text("runner").default("codex-cli").notNull(),
    model: text("model"),
    schemaVersion: integer("schema_version").default(1).notNull(),
    payload: jsonb("payload").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("analysis_jobs_idempotency_uidx").on(table.idempotencyKey),
    index("analysis_jobs_queue_idx").on(table.status, table.scheduledAt),
    index("analysis_jobs_entity_idx").on(table.entityType, table.entityId),
    check("analysis_jobs_attempt_count_chk", sql`${table.attemptCount} >= 0`),
  ],
);

export const analysisResults = pgTable(
  "analysis_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => analysisJobs.id, { onDelete: "cascade" }),
    entityType: entityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    resultType: text("result_type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    result: jsonb("result").$type<JsonObject>().notNull(),
    evidence: jsonb("evidence")
      .$type<SourceProvenance[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    evidenceMessageIds: uuid("evidence_message_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    confidence: doublePrecision("confidence").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    ...overrideColumns,
    ...timestamps,
  },
  (table) => [
    uniqueIndex("analysis_results_job_type_uidx").on(table.jobId, table.resultType),
    index("analysis_results_entity_idx").on(table.entityType, table.entityId),
    check("analysis_results_confidence_chk", sql`${table.confidence} between 0 and 1`),
  ],
);

export const syncCursors = pgTable(
  "sync_cursors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    integrationAccountId: uuid("integration_account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    cursorCiphertext: text("cursor_ciphertext").notNull(),
    cursorKeyVersion: integer("cursor_key_version").default(1).notNull(),
    lastSeenExternalId: text("last_seen_external_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("sync_cursors_account_resource_uidx").on(
      table.integrationAccountId,
      table.resource,
    ),
  ],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    integrationAccountId: uuid("integration_account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    resource: text("resource").notNull(),
    trigger: syncTriggerEnum("trigger").default("scheduled").notNull(),
    status: syncRunStatusEnum("status").default("queued").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cursorBeforeCiphertext: text("cursor_before_ciphertext"),
    cursorAfterCiphertext: text("cursor_after_ciphertext"),
    discoveredCount: integer("discovered_count").default(0).notNull(),
    insertedCount: integer("inserted_count").default(0).notNull(),
    updatedCount: integer("updated_count").default(0).notNull(),
    skippedCount: integer("skipped_count").default(0).notNull(),
    failedCount: integer("failed_count").default(0).notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("sync_runs_idempotency_uidx").on(table.idempotencyKey),
    index("sync_runs_account_started_idx").on(table.integrationAccountId, table.startedAt),
    index("sync_runs_status_idx").on(table.status, table.createdAt),
    check("sync_runs_discovered_count_chk", sql`${table.discoveredCount} >= 0`),
    check("sync_runs_inserted_count_chk", sql`${table.insertedCount} >= 0`),
    check("sync_runs_updated_count_chk", sql`${table.updatedCount} >= 0`),
    check("sync_runs_skipped_count_chk", sql`${table.skippedCount} >= 0`),
    check("sync_runs_failed_count_chk", sql`${table.failedCount} >= 0`),
  ],
);

export const settings = pgTable(
  "settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    category: text("category").default("general").notNull(),
    value: jsonb("value").$type<JsonObject>(),
    encryptedValue: text("encrypted_value"),
    isSecret: boolean("is_secret").default(false).notNull(),
    description: text("description"),
    ...overrideColumns,
    ...timestamps,
  },
  (table) => [
    uniqueIndex("settings_key_uidx").on(table.key),
    check(
      "settings_secret_storage_chk",
      sql`(${table.isSecret} = false and ${table.encryptedValue} is null) or (${table.isSecret} = true and ${table.value} is null and ${table.encryptedValue} is not null)`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    action: text("action").notNull(),
    outcome: auditOutcomeEnum("outcome").notNull(),
    actorEmail: text("actor_email").notNull(),
    entityType: entityTypeEnum("entity_type"),
    entityId: uuid("entity_id"),
    requestId: text("request_id"),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_occurred_idx").on(table.occurredAt),
    index("audit_events_entity_idx").on(table.entityType, table.entityId),
    index("audit_events_actor_idx").on(table.actorEmail, table.occurredAt),
  ],
);

export const companiesRelations = relations(companies, ({ many }) => ({
  contacts: many(contacts),
  outreachPlans: many(outreachPlans),
  touchpoints: many(touchpoints),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  company: one(companies, {
    fields: [contacts.companyId],
    references: [companies.id],
  }),
  identities: many(channelIdentities),
  outreachPlans: many(outreachPlans),
  touchpoints: many(touchpoints),
  conversationParticipants: many(conversationParticipants),
}));

export const integrationAccountsRelations = relations(integrationAccounts, ({ many }) => ({
  identities: many(channelIdentities),
  conversations: many(conversations),
  messages: many(messages),
  syncCursors: many(syncCursors),
  syncRuns: many(syncRuns),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  integrationAccount: one(integrationAccounts, {
    fields: [conversations.integrationAccountId],
    references: [integrationAccounts.id],
  }),
  participants: many(conversationParticipants),
  messages: many(messages),
  touchpoints: many(touchpoints),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  integrationAccount: one(integrationAccounts, {
    fields: [messages.integrationAccountId],
    references: [integrationAccounts.id],
  }),
  senderIdentity: one(channelIdentities, {
    fields: [messages.senderIdentityId],
    references: [channelIdentities.id],
  }),
  touchpoints: many(touchpoints),
}));

export const outreachPlansRelations = relations(outreachPlans, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [outreachPlans.contactId],
    references: [contacts.id],
  }),
  company: one(companies, {
    fields: [outreachPlans.companyId],
    references: [companies.id],
  }),
  touchpoints: many(touchpoints),
}));

export type IntegrationAccount = typeof integrationAccounts.$inferSelect;
export type NewIntegrationAccount = typeof integrationAccounts.$inferInsert;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type NewChannelIdentity = typeof channelIdentities.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type OutreachPlan = typeof outreachPlans.$inferSelect;
export type NewOutreachPlan = typeof outreachPlans.$inferInsert;
export type Touchpoint = typeof touchpoints.$inferSelect;
export type NewTouchpoint = typeof touchpoints.$inferInsert;
export type AnalysisJob = typeof analysisJobs.$inferSelect;
export type NewAnalysisJob = typeof analysisJobs.$inferInsert;
export type AnalysisResult = typeof analysisResults.$inferSelect;
export type NewAnalysisResult = typeof analysisResults.$inferInsert;
export type SyncCursor = typeof syncCursors.$inferSelect;
export type NewSyncCursor = typeof syncCursors.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
