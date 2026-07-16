import postgres from "postgres";

import {
  analysisJobInputSchema,
  type AnalysisJobInput,
  type AnalysisResultInput,
  type ManualOverride,
  type SourceProvenance,
} from "../../lib/domain/schemas";

import { WorkerError } from "./errors";
import { normalizeCompanyName, preserveManualOverrides } from "./normalization";
import { workerAnalysisResultSchema, type ClassificationOutput } from "./schema";
import type {
  AnalysisContext,
  AnalysisJobStore,
  AnalysisMessageContext,
  AnalysisParticipantContext,
  ClaimedAnalysisJob,
  FailureDisposition,
  JsonObject,
  PreparedAnalysisJob,
  StoreHealth,
} from "./types";

interface JobRow {
  id: string;
  idempotencyKey: string;
  jobType: ClaimedAnalysisJob["jobType"];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  entityType: ClaimedAnalysisJob["entityType"];
  entityId: string;
  inputHash: string;
  runner: string;
  model: string | null;
  schemaVersion: number;
  payload: JsonObject;
  attemptCount: number;
  scheduledAt: Date;
  startedAt: Date | null;
}

interface MessageRow {
  id: string;
  channel: AnalysisMessageContext["channel"];
  direction: AnalysisMessageContext["direction"];
  sentAt: Date;
  subject: string | null;
  bodyText: string | null;
  snippet: string | null;
  sourceProvenance: SourceProvenance[];
}

interface ParticipantRow {
  externalParticipantId: string;
  role: AnalysisParticipantContext["role"];
  displayName: string | null;
  address: string | null;
  contactId: string | null;
  identityId: string | null;
}

interface OverrideRow {
  manualOverrides: ManualOverride[];
}

type Database = ReturnType<typeof postgres>;
type Transaction = postgres.TransactionSql;

function jsonParameter(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

function asClaimedJob(row: JobRow): ClaimedAnalysisJob {
  if (!row.startedAt) throw new WorkerError("worker_internal", "Claimed job has no start time.");
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    jobType: row.jobType,
    entityType: row.entityType,
    entityId: row.entityId,
    inputHash: row.inputHash,
    runner: row.runner,
    model: row.model,
    schemaVersion: row.schemaVersion,
    payload: row.payload,
    attemptCount: row.attemptCount,
    scheduledAt: row.scheduledAt,
    startedAt: row.startedAt,
  };
}

function toMessageContext(row: MessageRow): AnalysisMessageContext {
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction,
    sentAt: row.sentAt.toISOString(),
    ...(row.subject === null ? {} : { subject: row.subject }),
    ...(row.bodyText === null ? {} : { bodyText: row.bodyText }),
    ...(row.snippet === null ? {} : { snippet: row.snippet }),
  };
}

function toParticipantContext(row: ParticipantRow): AnalysisParticipantContext {
  return {
    externalParticipantId: row.externalParticipantId,
    role: row.role,
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    ...(row.address === null ? {} : { address: row.address }),
    ...(row.contactId === null ? {} : { contactId: row.contactId }),
    ...(row.identityId === null ? {} : { identityId: row.identityId }),
  };
}

function flattenEvidence(rows: readonly MessageRow[]): SourceProvenance[] {
  const evidence = rows.flatMap((row) => row.sourceProvenance ?? []);
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.provider}:${item.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function analysisMetadata(jobId: string, output: ClassificationOutput): JsonObject {
  return {
    lastAnalysisJobId: jobId,
    sentiment: output.sentiment,
    intent: output.intent,
    nextAction: output.nextAction,
    rationale: output.rationale,
  };
}

function safeFailureMessage(code: string): string {
  return `Analysis failed with ${code}. No source content or model output is stored in this diagnostic.`;
}

export class PostgresAnalysisJobStore implements AnalysisJobStore {
  private readonly sql: Database;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      transform: postgres.camel,
    });
  }

  async checkHealth(): Promise<StoreHealth> {
    try {
      await this.sql`select 1 as ok`;
      return { ok: true };
    } catch {
      return { ok: false, detail: "Postgres is unavailable." };
    }
  }

  async recoverStaleJobs(now: Date, staleAfterMs: number, maxAttempts: number): Promise<number> {
    const cutoff = new Date(now.getTime() - staleAfterMs);
    return this.sql.begin(async (transaction) => {
      const dead = await transaction`
        update analysis_jobs
        set status = 'failed',
            failed_at = ${now},
            completed_at = null,
            error_code = 'dead_letter:stale_claim',
            error_message = ${safeFailureMessage("stale_claim")},
            updated_at = ${now}
        where status = 'running'
          and started_at < ${cutoff}
          and attempt_count >= ${maxAttempts}
        returning id
      `;
      const retried = await transaction`
        update analysis_jobs
        set status = 'queued',
            started_at = null,
            scheduled_at = ${now},
            error_code = 'retry:stale_claim',
            error_message = ${safeFailureMessage("stale_claim")},
            updated_at = ${now}
        where status = 'running'
          and started_at < ${cutoff}
          and attempt_count < ${maxAttempts}
        returning id
      `;
      return dead.length + retried.length;
    });
  }

  async claimNext(now: Date): Promise<ClaimedAnalysisJob | null> {
    const rows = await this.sql.begin(async (transaction) =>
      transaction<JobRow[]>`
        with next_job as (
          select id
          from analysis_jobs
          where status = 'queued'
            and scheduled_at <= ${now}
            and runner = 'codex-cli'
          order by scheduled_at asc, created_at asc, id asc
          for update skip locked
          limit 1
        )
        update analysis_jobs as job
        set status = 'running',
            attempt_count = job.attempt_count + 1,
            started_at = ${now},
            completed_at = null,
            failed_at = null,
            error_code = null,
            error_message = null,
            updated_at = ${now}
        from next_job
        where job.id = next_job.id
        returning job.*
      `,
    );

    const row = rows[0];
    return row ? asClaimedJob(row) : null;
  }

  async prepare(job: ClaimedAnalysisJob): Promise<PreparedAnalysisJob> {
    const context = await this.loadContext(job);
    const payload: JsonObject = {
      ...job.payload,
      $threadlineWorker: {
        jobId: job.id,
        context,
      },
    };

    const input: AnalysisJobInput = analysisJobInputSchema.parse({
      idempotencyKey: job.idempotencyKey,
      jobType: job.jobType,
      entity: { type: job.entityType, id: job.entityId },
      inputHash: job.inputHash,
      runner: job.runner,
      ...(job.model === null ? {} : { model: job.model }),
      schemaVersion: job.schemaVersion,
      payload,
    });

    return { claimed: job, input };
  }

  private async loadContext(job: ClaimedAnalysisJob): Promise<AnalysisContext> {
    let conversationId: string | null = null;
    let entitySnapshot: JsonObject = {};

    if (job.entityType === "conversation") {
      conversationId = job.entityId;
    } else if (job.entityType === "message") {
      const messageRows = await this.sql<{ conversationId: string }[]>`
        select conversation_id
        from messages
        where id = ${job.entityId}
        limit 1
      `;
      conversationId = messageRows[0]?.conversationId ?? null;
    } else if (job.entityType === "contact") {
      const contactRows = await this.sql<JsonObject[]>`
        select id, company_id, display_name, primary_email, title, seniority,
               relationship_stage, reply_state, planned_follow_up_at, metadata
        from contacts
        where id = ${job.entityId}
        limit 1
      `;
      entitySnapshot = contactRows[0] ?? {};
    } else if (job.entityType === "company") {
      const companyRows = await this.sql<JsonObject[]>`
        select id, name, domain, industry, size_range, location, description, metadata
        from companies
        where id = ${job.entityId}
        limit 1
      `;
      entitySnapshot = companyRows[0] ?? {};
    } else if (job.entityType === "outreach_plan") {
      const planRows = await this.sql<JsonObject[]>`
        select id, contact_id, company_id, status, objective, preferred_channels,
               next_touch_at, suggested_draft, metadata
        from outreach_plans
        where id = ${job.entityId}
        limit 1
      `;
      entitySnapshot = planRows[0] ?? {};
    } else {
      throw new WorkerError(
        "job_unsupported",
        `The Codex worker does not support ${job.entityType} analysis jobs.`,
      );
    }

    if (!conversationId) {
      return {
        participants: [],
        messages: [],
        entitySnapshot,
        evidence: [],
      };
    }

    const conversationRows = await this.sql<
      {
        id: string;
        channel: AnalysisContext["channel"];
        subject: string | null;
        preview: string | null;
        replyState: string;
        metadata: JsonObject;
      }[]
    >`
      select id, channel, subject, preview, reply_state, metadata
      from conversations
      where id = ${conversationId}
      limit 1
    `;
    const conversation = conversationRows[0];
    if (!conversation) {
      throw new WorkerError("job_unsupported", "The analysis conversation no longer exists.");
    }

    const messageRows = await this.sql<MessageRow[]>`
      select id, channel, direction, sent_at, subject, body_text, snippet, source_provenance
      from messages
      where conversation_id = ${conversationId}
      order by sent_at asc, id asc
    `;
    const participantRows = await this.sql<ParticipantRow[]>`
      select participant.external_participant_id,
             participant.role,
             participant.display_name,
             participant.address,
             participant.contact_id,
             participant.channel_identity_id as identity_id
      from conversation_participants as participant
      where participant.conversation_id = ${conversationId}
      order by case participant.role when 'contact' then 0 when 'other' then 1 else 2 end,
               participant.external_participant_id asc
    `;

    return {
      ...(conversation.channel === undefined ? {} : { channel: conversation.channel }),
      conversationId,
      ...(conversation.subject === null ? {} : { subject: conversation.subject }),
      participants: participantRows.map(toParticipantContext),
      messages: messageRows.map(toMessageContext),
      entitySnapshot: {
        id: conversation.id,
        preview: conversation.preview,
        replyState: conversation.replyState,
        metadata: conversation.metadata,
      },
      evidence: flattenEvidence(messageRows),
    };
  }

  async complete(job: ClaimedAnalysisJob, result: AnalysisResultInput, now: Date): Promise<void> {
    const parsed = workerAnalysisResultSchema.parse(result);
    const output = parsed.result;

    await this.sql.begin(async (transaction) => {
      const lockedJobs = await transaction<{ status: string; attemptCount: number }[]>`
        select status, attempt_count
        from analysis_jobs
        where id = ${job.id}
        for update
      `;
      const lockedJob = lockedJobs[0];
      if (!lockedJob || lockedJob.status !== "running" || lockedJob.attemptCount !== job.attemptCount) {
        throw new WorkerError("job_not_running", "The analysis job lease is no longer active.");
      }

      await transaction`
        insert into analysis_results (
          job_id, entity_type, entity_id, result_type, schema_version, result, evidence,
          evidence_message_ids, confidence, accepted_at, created_at, updated_at
        ) values (
          ${job.id}, ${job.entityType}, ${job.entityId}, ${parsed.resultType},
          ${parsed.schemaVersion}, ${transaction.json(jsonParameter(output))},
          ${transaction.json(jsonParameter(parsed.evidence))},
          ${transaction.array(output.evidenceMessageIds, 2950)}, ${output.confidence}, ${now}, ${now}, ${now}
        )
      `;

      let conversationId: string | null = null;
      if (job.entityType === "conversation") {
        conversationId = job.entityId;
      } else if (job.entityType === "message") {
        const rows = await transaction<{ conversationId: string }[]>`
          select conversation_id from messages where id = ${job.entityId} limit 1
        `;
        conversationId = rows[0]?.conversationId ?? null;
      }

      if (conversationId) {
        await this.applyConversationNormalization(transaction, conversationId, job.id, output, now);
      } else if (job.entityType === "contact") {
        await this.applyContactNormalization(transaction, job.entityId, null, job.id, output, now);
      } else if (job.entityType === "company") {
        await this.applyCompanyNormalization(transaction, job.entityId, job.id, output, now);
      }

      const completed = await transaction`
        update analysis_jobs
        set status = 'succeeded', completed_at = ${now}, failed_at = null,
            error_code = null, error_message = null, updated_at = ${now}
        where id = ${job.id}
          and status = 'running'
          and attempt_count = ${job.attemptCount}
        returning id
      `;
      if (completed.length !== 1) {
        throw new WorkerError("transaction_conflict", "The analysis job could not be completed atomically.");
      }
    });
  }

  private async applyConversationNormalization(
    transaction: Transaction,
    conversationId: string,
    jobId: string,
    output: ClassificationOutput,
    now: Date,
  ): Promise<void> {
    const conversations = await transaction<
      (OverrideRow & {
        isCustomerOutreach: boolean | null;
        outreachConfidence: number;
        replyState: "unknown" | "awaiting_reply" | "replied" | "not_applicable";
        metadata: JsonObject;
      })[]
    >`
      select is_customer_outreach, outreach_confidence, reply_state, metadata, manual_overrides
      from conversations
      where id = ${conversationId}
      for update
    `;
    const conversation = conversations[0];
    if (!conversation) throw new WorkerError("job_unsupported", "The analysis conversation no longer exists.");

    const nextConversation = preserveManualOverrides(
      conversation,
      {
        isCustomerOutreach: output.isCustomerOutreach,
        outreachConfidence: output.confidence,
        replyState: output.reply.state,
        metadata: { ...conversation.metadata, threadlineAnalysis: analysisMetadata(jobId, output) },
      },
      conversation.manualOverrides,
    );

    await transaction`
      update conversations
      set is_customer_outreach = ${nextConversation.isCustomerOutreach},
          outreach_confidence = ${nextConversation.outreachConfidence},
          reply_state = ${nextConversation.replyState},
          metadata = ${transaction.json(jsonParameter(nextConversation.metadata))},
          updated_at = ${now}
      where id = ${conversationId}
    `;

    const participantRows = await transaction<ParticipantRow[]>`
      select participant.external_participant_id,
             participant.role,
             participant.display_name,
             participant.address,
             participant.contact_id,
             participant.channel_identity_id as identity_id
      from conversation_participants as participant
      where participant.conversation_id = ${conversationId}
        and participant.role <> 'owner'
      order by case participant.role when 'contact' then 0 else 1 end,
               participant.external_participant_id asc
      limit 1
      for update
    `;
    const participant = participantRows[0];
    let companyId: string | null = null;
    if (output.company.name) {
      companyId = await this.upsertCompany(transaction, output, jobId, now);
    }

    let contactId = participant?.contactId ?? null;
    if (!contactId && participant) {
      const displayName = output.person.displayName ?? participant.displayName ?? participant.address;
      if (displayName) {
        const inserted = await transaction<{ id: string }[]>`
          insert into contacts (
            company_id, display_name, given_name, family_name, primary_email, title, seniority,
            relationship_stage, reply_state, planned_follow_up_at, confidence, metadata,
            source_confidence, created_at, updated_at
          ) values (
            ${companyId}, ${displayName}, ${output.person.givenName}, ${output.person.familyName},
            ${output.person.email}, ${output.role.title}, ${output.role.seniority},
            ${output.relationshipStage}, ${output.reply.state}, ${output.nextAction.followUpAt},
            ${output.confidence},
            ${transaction.json(jsonParameter({ threadlineAnalysis: analysisMetadata(jobId, output) }))},
            ${output.confidence}, ${now}, ${now}
          )
          returning id
        `;
        contactId = inserted[0]?.id ?? null;
        if (contactId) {
          await transaction`
            update conversation_participants
            set contact_id = ${contactId}, updated_at = ${now}
            where conversation_id = ${conversationId}
              and external_participant_id = ${participant.externalParticipantId}
          `;
          if (participant.identityId) {
            await transaction`
              update channel_identities
              set contact_id = ${contactId}, updated_at = ${now}
              where id = ${participant.identityId}
                and contact_id is null
            `;
          }
        }
      }
    }

    if (contactId) {
      await this.applyContactNormalization(transaction, contactId, companyId, jobId, output, now);
      await this.applyOutreachPlanNormalization(transaction, contactId, output, now);
    }

    if (output.reply.detected) {
      const outboundRows = await transaction<(OverrideRow & { id: string; hasReply: boolean; replyReceivedAt: Date | null })[]>`
        select id, has_reply, reply_received_at, manual_overrides
        from messages
        where conversation_id = ${conversationId}
          and direction = 'outbound'
        order by sent_at desc, id desc
        limit 1
        for update
      `;
      const outbound = outboundRows[0];
      if (outbound) {
        const nextMessage = preserveManualOverrides(
          outbound,
          {
            hasReply: true,
            replyReceivedAt: output.reply.latestReplyAt ? new Date(output.reply.latestReplyAt) : now,
          },
          outbound.manualOverrides,
        );
        await transaction`
          update messages
          set has_reply = ${nextMessage.hasReply},
              reply_received_at = ${nextMessage.replyReceivedAt},
              updated_at = ${now}
          where id = ${outbound.id}
        `;
      }
    }
  }

  private async upsertCompany(
    transaction: Transaction,
    output: ClassificationOutput,
    jobId: string,
    now: Date,
  ): Promise<string | null> {
    if (!output.company.name) return null;
    const normalizedName = normalizeCompanyName(output.company.name);
    const rows = output.company.domain
      ? await transaction<(OverrideRow & { id: string })[]>`
          select id, manual_overrides
          from companies
          where domain = ${output.company.domain}
          limit 1
          for update
        `
      : await transaction<(OverrideRow & { id: string })[]>`
          select id, manual_overrides
          from companies
          where normalized_name = ${normalizedName}
          order by created_at asc
          limit 1
          for update
        `;

    const existing = rows[0];
    if (existing) {
      await this.applyCompanyNormalization(transaction, existing.id, jobId, output, now);
      return existing.id;
    }

    const inserted = await transaction<{ id: string }[]>`
      insert into companies (
        name, normalized_name, domain, confidence, metadata, source_confidence, created_at, updated_at
      ) values (
        ${output.company.name}, ${normalizedName}, ${output.company.domain}, ${output.confidence},
        ${transaction.json(jsonParameter({ threadlineAnalysis: analysisMetadata(jobId, output) }))},
        ${output.confidence}, ${now}, ${now}
      )
      returning id
    `;
    return inserted[0]?.id ?? null;
  }

  private async applyCompanyNormalization(
    transaction: Transaction,
    companyId: string,
    jobId: string,
    output: ClassificationOutput,
    now: Date,
  ): Promise<void> {
    const rows = await transaction<
      (OverrideRow & {
        id: string;
        name: string;
        normalizedName: string;
        domain: string | null;
        confidence: number;
        metadata: JsonObject;
      })[]
    >`
      select id, name, normalized_name, domain, confidence, metadata, manual_overrides
      from companies
      where id = ${companyId}
      for update
    `;
    const company = rows[0];
    if (!company) return;
    const proposedName = output.company.name ?? company.name;
    const nextCompany = preserveManualOverrides(
      company,
      {
        name: proposedName,
        normalizedName: normalizeCompanyName(proposedName),
        domain: output.company.domain ?? company.domain,
        confidence: output.confidence,
        metadata: { ...company.metadata, threadlineAnalysis: analysisMetadata(jobId, output) },
      },
      company.manualOverrides,
    );
    await transaction`
      update companies
      set name = ${nextCompany.name},
          normalized_name = ${nextCompany.normalizedName},
          domain = ${nextCompany.domain},
          confidence = ${nextCompany.confidence},
          metadata = ${transaction.json(jsonParameter(nextCompany.metadata))},
          updated_at = ${now}
      where id = ${companyId}
    `;
  }

  private async applyContactNormalization(
    transaction: Transaction,
    contactId: string,
    companyId: string | null,
    jobId: string,
    output: ClassificationOutput,
    now: Date,
  ): Promise<void> {
    const rows = await transaction<
      (OverrideRow & {
        id: string;
        companyId: string | null;
        displayName: string;
        givenName: string | null;
        familyName: string | null;
        primaryEmail: string | null;
        title: string | null;
        seniority: string | null;
        relationshipStage: ClassificationOutput["relationshipStage"];
        replyState: ClassificationOutput["reply"]["state"];
        plannedFollowUpAt: Date | null;
        confidence: number;
        metadata: JsonObject;
      })[]
    >`
      select id, company_id, display_name, given_name, family_name, primary_email, title,
             seniority, relationship_stage, reply_state, planned_follow_up_at, confidence,
             metadata, manual_overrides
      from contacts
      where id = ${contactId}
      for update
    `;
    const contact = rows[0];
    if (!contact) return;
    const nextContact = preserveManualOverrides(
      contact,
      {
        companyId: companyId ?? contact.companyId,
        displayName: output.person.displayName ?? contact.displayName,
        givenName: output.person.givenName ?? contact.givenName,
        familyName: output.person.familyName ?? contact.familyName,
        primaryEmail: output.person.email ?? contact.primaryEmail,
        title: output.role.title ?? contact.title,
        seniority: output.role.seniority ?? contact.seniority,
        relationshipStage: output.relationshipStage,
        replyState: output.reply.state,
        plannedFollowUpAt: output.nextAction.followUpAt
          ? new Date(output.nextAction.followUpAt)
          : contact.plannedFollowUpAt,
        confidence: output.confidence,
        metadata: { ...contact.metadata, threadlineAnalysis: analysisMetadata(jobId, output) },
      },
      contact.manualOverrides,
    );
    await transaction`
      update contacts
      set company_id = ${nextContact.companyId},
          display_name = ${nextContact.displayName},
          given_name = ${nextContact.givenName},
          family_name = ${nextContact.familyName},
          primary_email = ${nextContact.primaryEmail},
          title = ${nextContact.title},
          seniority = ${nextContact.seniority},
          relationship_stage = ${nextContact.relationshipStage},
          reply_state = ${nextContact.replyState},
          planned_follow_up_at = ${nextContact.plannedFollowUpAt},
          confidence = ${nextContact.confidence},
          metadata = ${transaction.json(jsonParameter(nextContact.metadata))},
          updated_at = ${now}
      where id = ${contactId}
    `;
  }

  private async applyOutreachPlanNormalization(
    transaction: Transaction,
    contactId: string,
    output: ClassificationOutput,
    now: Date,
  ): Promise<void> {
    const rows = await transaction<
      (OverrideRow & { id: string; nextTouchAt: Date | null; metadata: JsonObject })[]
    >`
      select id, next_touch_at, metadata, manual_overrides
      from outreach_plans
      where contact_id = ${contactId}
        and status in ('draft', 'planned', 'active', 'paused')
      order by updated_at desc, id desc
      limit 1
      for update
    `;
    const plan = rows[0];
    if (!plan) return;
    const nextPlan = preserveManualOverrides(
      plan,
      {
        nextTouchAt: output.nextAction.followUpAt
          ? new Date(output.nextAction.followUpAt)
          : plan.nextTouchAt,
        metadata: {
          ...plan.metadata,
          recommendedAction: output.nextAction.recommendation,
          recommendedActionSummary: output.nextAction.summary,
        },
      },
      plan.manualOverrides,
    );
    await transaction`
      update outreach_plans
      set next_touch_at = ${nextPlan.nextTouchAt},
          metadata = ${transaction.json(jsonParameter(nextPlan.metadata))},
          updated_at = ${now}
      where id = ${plan.id}
    `;
  }

  async fail(
    job: ClaimedAnalysisJob,
    failure: { code: string; message: string; retryable: boolean },
    now: Date,
    maxAttempts: number,
    retryDelayMs: number,
  ): Promise<FailureDisposition> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<{ status: string; attemptCount: number }[]>`
        select status, attempt_count
        from analysis_jobs
        where id = ${job.id}
        for update
      `;
      const current = rows[0];
      if (!current || current.status !== "running" || current.attemptCount !== job.attemptCount) {
        throw new WorkerError("job_not_running", "The failed analysis job lease is no longer active.");
      }

      const deadLetter = !failure.retryable || job.attemptCount >= maxAttempts;
      if (deadLetter) {
        await transaction`
          update analysis_jobs
          set status = 'failed', failed_at = ${now}, completed_at = null,
              error_code = ${`dead_letter:${failure.code}`},
              error_message = ${safeFailureMessage(failure.code)},
              updated_at = ${now}
          where id = ${job.id}
        `;
        return { state: "dead_letter" };
      }

      const delay = retryDelayMs * 2 ** Math.max(0, job.attemptCount - 1);
      const nextAttemptAt = new Date(now.getTime() + delay);
      await transaction`
        update analysis_jobs
        set status = 'queued', started_at = null, failed_at = null, completed_at = null,
            scheduled_at = ${nextAttemptAt},
            error_code = ${`retry:${failure.code}`},
            error_message = ${safeFailureMessage(failure.code)},
            updated_at = ${now}
        where id = ${job.id}
      `;
      return { state: "retry_scheduled", nextAttemptAt };
    });
  }

  async releaseForShutdown(job: ClaimedAnalysisJob, now: Date): Promise<void> {
    await this.sql`
      update analysis_jobs
      set status = 'queued',
          attempt_count = greatest(attempt_count - 1, 0),
          started_at = null,
          scheduled_at = ${now},
          error_code = null,
          error_message = null,
          updated_at = ${now}
      where id = ${job.id}
        and status = 'running'
        and attempt_count = ${job.attemptCount}
    `;
  }

  close(): Promise<void> {
    return this.sql.end();
  }
}
