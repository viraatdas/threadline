import { rm } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import validOutput from "./fixtures/valid-output.json";
import { FakeCodexExecutable } from "../../worker/codex/executable";
import { WorkerHealth } from "../../worker/codex/health";
import { PostgresAnalysisJobStore } from "../../worker/codex/postgres-store";
import { CodexCliAnalysisRunner } from "../../worker/codex/runner";
import { CodexWorker } from "../../worker/codex/worker";
import {
  CONVERSATION_ID,
  FixedClock,
  JOB_ID,
  RecordingLogger,
  workerConfig,
} from "./helpers";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required in CI.");
}
const describeDatabase = databaseUrl ? describe : describe.skip;
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";
const INTEGRATION_ID = "66666666-6666-4666-8666-666666666666";
const PLAN_ID = "77777777-7777-4777-8777-777777777777";
const DRAFT_OUTPUT = {
  text: "Hi Jordan, thanks for getting back to me. Would Tuesday afternoon work for a quick chat?",
  confidence: 0.91,
  evidenceMessageIds: ["44444444-4444-4444-8444-444444444444"],
};

describeDatabase("Postgres analysis job store", () => {
  const sql = postgres(databaseUrl!, { prepare: false, transform: postgres.camel });
  const temporaryPaths = new Set<string>();

  beforeAll(async () => {
    const migrationSql = postgres(databaseUrl!, { max: 1, prepare: false });
    try {
      await migrate(drizzle(migrationSql), { migrationsFolder: "migrations" });
    } finally {
      await migrationSql.end();
    }
  });

  beforeEach(async () => {
    await sql`
      truncate table analysis_results, analysis_jobs, touchpoints, outreach_plans, messages,
                     conversation_participants, conversations, channel_identities, contacts,
                     companies, integration_accounts restart identity cascade
    `;
    await seedAnalysisJob(sql);
  });

  afterAll(async () => {
    await Promise.all([...temporaryPaths].map((path) => rm(path, { force: true, recursive: true })));
    await sql.end();
  });

  it("claims once and transactionally normalizes a schema-valid result", async () => {
    const store = new PostgresAnalysisJobStore(databaseUrl!);
    const now = new Date("2026-07-15T18:10:00.000Z");
    const [first, second] = await Promise.all([store.claimNext(now), store.claimNext(now)]);
    const claimed = first ?? second;

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(claimed?.id).toBe(JOB_ID);
    await store.releaseForShutdown(claimed!, now);

    const { worker } = createWorker(store, [{ output: validOutput }], temporaryPaths);
    await expect(worker.runOne(new AbortController().signal)).resolves.toBe("processed");

    const jobs = await sql<{ status: string; attemptCount: number }[]>`
      select status, attempt_count from analysis_jobs where id = ${JOB_ID}
    `;
    const results = await sql<{ count: number }[]>`
      select count(*)::int as count from analysis_results where job_id = ${JOB_ID}
    `;
    const conversations = await sql<
      { isCustomerOutreach: boolean | null; replyState: string; outreachConfidence: number }[]
    >`
      select is_customer_outreach, reply_state, outreach_confidence
      from conversations where id = ${CONVERSATION_ID}
    `;
    const contacts = await sql<
      { displayName: string; replyState: string; relationshipStage: string; companyId: string | null }[]
    >`
      select display_name, reply_state, relationship_stage, company_id
      from contacts where id = ${CONTACT_ID}
    `;
    const companies = await sql<{ name: string; domain: string | null }[]>`
      select name, domain from companies where id = ${contacts[0]!.companyId}
    `;
    const outbound = await sql<{ hasReply: boolean; replyReceivedAt: Date | null }[]>`
      select has_reply, reply_received_at
      from messages
      where id = '33333333-3333-4333-8333-333333333333'
    `;

    expect(jobs[0]).toEqual({ status: "succeeded", attemptCount: 1 });
    expect(results[0]?.count).toBe(1);
    expect(conversations[0]).toMatchObject({
      isCustomerOutreach: false,
      replyState: "replied",
      outreachConfidence: 0.94,
    });
    expect(contacts[0]).toMatchObject({
      displayName: "Manually Reviewed Jordan",
      replyState: "replied",
      relationshipStage: "replied",
    });
    expect(companies[0]).toEqual({ name: "Example Labs", domain: "example.com" });
    expect(outbound[0]?.hasReply).toBe(true);
    expect(outbound[0]?.replyReceivedAt?.toISOString()).toBe("2026-07-15T18:05:00.000Z");
    await store.close();
  });

  it("loads bounded recent contact context and atomically persists an outreach draft", async () => {
    await replaceWithDraftJob(sql);
    const store = new PostgresAnalysisJobStore(databaseUrl!, 1);
    const { executable, worker } = createWorker(store, [{ output: DRAFT_OUTPUT }], temporaryPaths);

    await expect(worker.runOne(new AbortController().signal)).resolves.toBe("processed");

    const jobs = await sql<{ status: string; attemptCount: number }[]>`
      select status, attempt_count from analysis_jobs where id = ${JOB_ID}
    `;
    const results = await sql<
      { resultType: string; result: typeof DRAFT_OUTPUT; evidenceMessageIds: string[] }[]
    >`
      select result_type, result, evidence_message_ids
      from analysis_results
      where job_id = ${JOB_ID}
    `;
    const plans = await sql<{ suggestedDraft: string | null }[]>`
      select suggested_draft from outreach_plans where id = ${PLAN_ID}
    `;
    const prompt = executable.requests[0]?.stdin ?? "";

    expect(jobs[0]).toEqual({ status: "succeeded", attemptCount: 1 });
    expect(results[0]).toMatchObject({
      resultType: "outreach_draft",
      result: DRAFT_OUTPUT,
      evidenceMessageIds: DRAFT_OUTPUT.evidenceMessageIds,
    });
    expect(plans[0]?.suggestedDraft).toBe(DRAFT_OUTPUT.text);
    expect(prompt).toContain("Book a short follow-up conversation");
    expect(prompt).toContain("Manually Reviewed Jordan");
    expect(prompt).toContain("Yes, please send times.");
    expect(prompt).not.toContain("Hi Jordan, are you open to discussing Threadline?");
    await store.close();
  });

  it("stores the draft result without replacing an explicitly overridden plan draft", async () => {
    await replaceWithDraftJob(sql, true);
    const store = new PostgresAnalysisJobStore(databaseUrl!);
    const { worker } = createWorker(store, [{ output: DRAFT_OUTPUT }], temporaryPaths);

    await expect(worker.runOne(new AbortController().signal)).resolves.toBe("processed");

    const plans = await sql<{ suggestedDraft: string | null }[]>`
      select suggested_draft from outreach_plans where id = ${PLAN_ID}
    `;
    const results = await sql<{ count: number }[]>`
      select count(*)::int as count
      from analysis_results
      where job_id = ${JOB_ID} and result_type = 'outreach_draft'
    `;
    const jobs = await sql<{ status: string }[]>`
      select status from analysis_jobs where id = ${JOB_ID}
    `;

    expect(plans[0]?.suggestedDraft).toBe("Owner-written draft");
    expect(results[0]?.count).toBe(1);
    expect(jobs[0]?.status).toBe("succeeded");
    await store.close();
  });

  it("rolls back the draft result and plan text when atomic job completion fails", async () => {
    await replaceWithDraftJob(sql);
    await sql.unsafe(`
      create or replace function fail_draft_success_for_test() returns trigger as $$
      begin
        if new.status = 'succeeded' then
          raise exception 'forced draft success failure';
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger fail_draft_success_for_test
      before update on analysis_jobs
      for each row execute function fail_draft_success_for_test();
    `);

    const store = new PostgresAnalysisJobStore(databaseUrl!);
    try {
      const { worker } = createWorker(store, [{ output: DRAFT_OUTPUT }], temporaryPaths);
      await expect(worker.runOne(new AbortController().signal)).resolves.toBe("failed");

      const plans = await sql<{ suggestedDraft: string | null }[]>`
        select suggested_draft from outreach_plans where id = ${PLAN_ID}
      `;
      const results = await sql<{ count: number }[]>`
        select count(*)::int as count from analysis_results where job_id = ${JOB_ID}
      `;
      const jobs = await sql<{ status: string; errorCode: string | null }[]>`
        select status, error_code from analysis_jobs where id = ${JOB_ID}
      `;

      expect(plans[0]?.suggestedDraft).toBeNull();
      expect(results[0]?.count).toBe(0);
      expect(jobs[0]).toEqual({ status: "failed", errorCode: "dead_letter:worker_internal" });
    } finally {
      await store.close();
      await sql.unsafe("drop trigger if exists fail_draft_success_for_test on analysis_jobs");
      await sql.unsafe("drop function if exists fail_draft_success_for_test()");
    }
  });

  it("rolls back result and normalized rows when the final job update fails", async () => {
    await sql.unsafe(`
      create or replace function fail_analysis_success_for_test() returns trigger as $$
      begin
        if new.status = 'succeeded' then
          raise exception 'forced success failure';
        end if;
        return new;
      end;
      $$ language plpgsql;
      create trigger fail_analysis_success_for_test
      before update on analysis_jobs
      for each row execute function fail_analysis_success_for_test();
    `);

    const store = new PostgresAnalysisJobStore(databaseUrl!);
    try {
      const { worker } = createWorker(store, [{ output: validOutput }], temporaryPaths);
      await expect(worker.runOne(new AbortController().signal)).resolves.toBe("failed");

      const results = await sql<{ count: number }[]>`
        select count(*)::int as count from analysis_results where job_id = ${JOB_ID}
      `;
      const conversations = await sql<{ replyState: string; outreachConfidence: number }[]>`
        select reply_state, outreach_confidence from conversations where id = ${CONVERSATION_ID}
      `;
      const jobs = await sql<{ status: string; errorCode: string | null }[]>`
        select status, error_code from analysis_jobs where id = ${JOB_ID}
      `;

      expect(results[0]?.count).toBe(0);
      expect(conversations[0]).toEqual({ replyState: "unknown", outreachConfidence: 0 });
      expect(jobs[0]).toEqual({ status: "failed", errorCode: "dead_letter:worker_internal" });
    } finally {
      await store.close();
      await sql.unsafe("drop trigger if exists fail_analysis_success_for_test on analysis_jobs");
      await sql.unsafe("drop function if exists fail_analysis_success_for_test()");
    }
  });
});

function createWorker(
  store: PostgresAnalysisJobStore,
  responses: ConstructorParameters<typeof FakeCodexExecutable>[0],
  temporaryPaths: Set<string>,
) {
  const workdir = `/tmp/threadline-postgres-worker-${crypto.randomUUID()}`;
  temporaryPaths.add(workdir);
  const config = workerConfig({ CODEX_WORKDIR: workdir });
  const executable = new FakeCodexExecutable(responses);
  const runner = new CodexCliAnalysisRunner(config, executable);
  const clock = new FixedClock();
  return {
    executable,
    worker: new CodexWorker(
      config,
      store,
      runner,
      clock,
      new RecordingLogger(),
      new WorkerHealth(clock.now()),
    ),
  };
}

async function replaceWithDraftJob(
  sql: ReturnType<typeof postgres>,
  manualDraft = false,
): Promise<void> {
  const manualOverrides = manualDraft
    ? [
        {
          field: "suggestedDraft",
          value: "Owner-written draft",
          reason: "Written directly by the owner.",
          overriddenAt: "2026-07-15T18:09:00.000Z",
          overriddenBy: "owner@example.com",
        },
      ]
    : [];
  await sql`delete from analysis_jobs where id = ${JOB_ID}`;
  await sql`
    insert into outreach_plans (
      id, contact_id, status, objective, preferred_channels, next_touch_at,
      suggested_draft, has_manual_override, manual_overrides
    ) values (
      ${PLAN_ID}, ${CONTACT_ID}, 'planned', 'Book a short follow-up conversation',
      array['gmail']::channel[], '2026-07-17T20:00:00.000Z',
      ${manualDraft ? "Owner-written draft" : null}, ${manualDraft}, ${sql.json(manualOverrides)}
    )
  `;
  const payload = {
    planId: PLAN_ID,
    contactId: CONTACT_ID,
    companyId: null,
    objective: "Book a short follow-up conversation",
    preferredChannels: ["gmail"],
    nextTouchAt: "2026-07-17T20:00:00.000Z",
    requestedBy: "owner@example.com",
    requestReason: "plan_saved",
  };
  await sql`
    insert into analysis_jobs (
      id, idempotency_key, job_type, status, entity_type, entity_id, input_hash,
      runner, model, schema_version, payload, scheduled_at
    ) values (
      ${JOB_ID}, 'analysis:outreach-plan:77777777', 'draft_outreach', 'queued',
      'outreach_plan', ${PLAN_ID}, '0123456789abcdef0123456789abcdef',
      'codex-cli', 'gpt-5.6-luna', 1, ${sql.json(payload)},
      '2026-07-15T18:00:00.000Z'
    )
  `;
}

async function seedAnalysisJob(sql: ReturnType<typeof postgres>): Promise<void> {
  const manualOverrides = [
    {
      field: "isCustomerOutreach",
      value: false,
      reason: "Owner classified this manually.",
      overriddenAt: "2026-07-15T18:09:00.000Z",
      overriddenBy: "owner@example.com",
    },
  ];
  const contactOverrides = [
    {
      field: "displayName",
      value: "Manually Reviewed Jordan",
      overriddenAt: "2026-07-15T18:09:00.000Z",
      overriddenBy: "owner@example.com",
    },
  ];
  const provenance = [
    {
      provider: "gmail",
      integrationAccountId: INTEGRATION_ID,
      externalId: "message-1",
      collectedAt: "2026-07-15T18:06:00.000Z",
      confidence: 1,
      metadata: {},
    },
  ];

  await sql`
    insert into integration_accounts (
      id, provider, external_account_id, display_name, account_email, status,
      credential_ciphertext, connected_at
    ) values (
      ${INTEGRATION_ID}, 'gmail', 'owner@example.com', 'Owner Gmail', 'owner@example.com',
      'connected', 'sealed-test-credential', now()
    )
  `;
  await sql`
    insert into contacts (
      id, display_name, primary_email, relationship_stage, reply_state,
      has_manual_override, manual_overrides
    ) values (
      ${CONTACT_ID}, 'Manually Reviewed Jordan', 'jordan@example.com', 'unreviewed', 'unknown',
      true, ${sql.json(contactOverrides)}
    )
  `;
  await sql`
    insert into conversations (
      id, integration_account_id, channel, external_conversation_id, idempotency_key,
      subject, reply_state, is_customer_outreach, outreach_confidence,
      has_manual_override, manual_overrides
    ) values (
      ${CONVERSATION_ID}, ${INTEGRATION_ID}, 'gmail', 'thread-1', 'gmail:thread:thread-1',
      'Quick partnership question', 'unknown', false, 0, true, ${sql.json(manualOverrides)}
    )
  `;
  await sql`
    insert into conversation_participants (
      conversation_id, contact_id, external_participant_id, role, display_name, address
    ) values (
      ${CONVERSATION_ID}, ${CONTACT_ID}, 'jordan@example.com', 'contact',
      'Jordan Lee', 'jordan@example.com'
    )
  `;
  await sql`
    insert into messages (
      id, conversation_id, integration_account_id, channel, external_message_id,
      idempotency_key, direction, sent_at, body_text, source_provenance
    ) values
      (
        '33333333-3333-4333-8333-333333333333', ${CONVERSATION_ID}, ${INTEGRATION_ID},
        'gmail', 'message-1', 'gmail:message:message-1', 'outbound',
        '2026-07-15T18:00:00.000Z', 'Hi Jordan, are you open to discussing Threadline?',
        ${sql.json(provenance)}
      ),
      (
        '44444444-4444-4444-8444-444444444444', ${CONVERSATION_ID}, ${INTEGRATION_ID},
        'gmail', 'message-2', 'gmail:message:message-2', 'inbound',
        '2026-07-15T18:05:00.000Z', 'Yes, please send times.', ${sql.json(provenance)}
      )
  `;
  await sql`
    insert into analysis_jobs (
      id, idempotency_key, job_type, status, entity_type, entity_id, input_hash,
      runner, model, schema_version, payload, scheduled_at
    ) values (
      ${JOB_ID}, 'analysis:conversation:22222222', 'classify_outreach', 'queued',
      'conversation', ${CONVERSATION_ID}, '0123456789abcdef0123456789abcdef',
      'codex-cli', 'gpt-5.6-luna', 1, ${sql.json({ source: "integration-test" })},
      '2026-07-15T18:00:00.000Z'
    )
  `;
}
