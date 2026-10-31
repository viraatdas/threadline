import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { CampaignStep, CompanyStatus, PersonStage } from "@/lib/domain";

type JsonObject = Record<string, unknown>;

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

// One row per provider (gmail, linkedin, github, apollo). Credentials are AES-256-GCM sealed;
// the plaintext never touches a column, a log, or the client.
export const connections = pgTable("connections", {
  provider: text("provider").$type<"gmail" | "linkedin" | "github" | "apollo">().primaryKey(),
  label: text("label").notNull(),
  credentialCiphertext: text("credential_ciphertext").notNull(),
  credentialKeyVersion: integer("credential_key_version").default(1).notNull(),
  lastError: text("last_error"),
  metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
  ...timestamps,
});

// Single owner, single row: the product pitch, sender identity, and limits.
export const settings = pgTable("settings", {
  id: text("id").primaryKey().default("owner"),
  value: jsonb("value").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    domain: text("domain"),
    website: text("website"),
    description: text("description"),
    location: text("location"),
    teamSize: integer("team_size"),
    linkedinUrl: text("linkedin_url"),
    githubLogin: text("github_login"),
    ycSlug: text("yc_slug"),
    ycBatch: text("yc_batch"),
    source: text("source").notNull(),
    status: text("status").$type<CompanyStatus>().default("new").notNull(),
    // 0–100 fit for Offstage, set by research; null until researched.
    score: integer("score"),
    fitSummary: text("fit_summary"),
    hook: text("hook"),
    researchedAt: timestamp("researched_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("companies_domain_uidx").on(table.domain),
    uniqueIndex("companies_github_uidx").on(table.githubLogin),
    uniqueIndex("companies_yc_uidx").on(table.ycSlug),
    index("companies_status_score_idx").on(table.status, table.score),
  ],
);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  // The angle: who this is for and why now. Fed to every draft.
  angle: text("angle").notNull(),
  steps: jsonb("steps").$type<CampaignStep[]>().notNull(),
  active: boolean("active").default(true).notNull(),
  ...timestamps,
});

export const people = pgTable(
  "people",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    title: text("title"),
    email: text("email"),
    // found = from a source that saw it; guessed = pattern guess, verify first.
    emailStatus: text("email_status").$type<"found" | "guessed" | "bounced">(),
    linkedinUrl: text("linkedin_url"),
    twitterUrl: text("twitter_url"),
    location: text("location"),
    source: text("source").notNull(),
    stage: text("stage").$type<PersonStage>().default("new").notNull(),
    closedReason: text("closed_reason"),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    // Index into campaign.steps of the next step to draft, and when it is due.
    nextStep: integer("next_step").default(0).notNull(),
    nextStepAt: timestamp("next_step_at", { withTimezone: true }),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    notes: text("notes"),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("people_email_uidx").on(table.email),
    uniqueIndex("people_linkedin_uidx").on(table.linkedinUrl),
    index("people_company_idx").on(table.companyId),
    index("people_stage_next_idx").on(table.stage, table.nextStepAt),
  ],
);

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    url: text("url"),
    // 1 = weak context, 2 = relevant, 3 = they are feeling the pain right now.
    strength: integer("strength").default(1).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("signals_dedupe_uidx").on(table.dedupeKey),
    index("signals_company_idx").on(table.companyId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    step: integer("step"),
    channel: text("channel").$type<"email" | "linkedin_invite" | "linkedin_message">().notNull(),
    direction: text("direction").$type<"out" | "in">().default("out").notNull(),
    status: text("status")
      .$type<"draft" | "sending" | "sent" | "failed" | "skipped" | "received">()
      .default("draft")
      .notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // Gmail message id or Linked API workflow id; threadId groups follow-ups.
    externalId: text("external_id"),
    threadId: text("thread_id"),
    error: text("error"),
    metadata: jsonb("metadata").$type<JsonObject>().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => [
    index("messages_status_due_idx").on(table.status, table.dueAt),
    index("messages_person_idx").on(table.personId, table.createdAt),
    // A step is drafted at most once per person per campaign.
    uniqueIndex("messages_step_uidx")
      .on(table.personId, table.campaignId, table.step)
      .where(sql`${table.direction} = 'out'`),
  ],
);

export type Connection = typeof connections.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type Signal = typeof signals.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Message = typeof messages.$inferSelect;
