import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { revalidatePathMock } = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/auth", () => ({
  requireOwner: vi.fn(async () => ({ user: { email: "owner@example.com" } })),
}));

import {
  addContact,
  completeOutreachPlan,
  correctCompany,
  correctContact,
  editCompany,
  editContact,
  mergeContacts,
  rescheduleOutreachPlan,
  retryOutreachDraft,
  upsertOutreachPlan,
} from "@/app/(dashboard)/workspace-actions";
import { closeDatabase } from "@/lib/db/client";
import {
  loadCompanyWorkspaceData,
  loadPersonWorkspaceData,
} from "@/lib/db/workspace";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required in CI.");
}
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const describeDatabase = databaseUrl ? describe.sequential : describe.skip;

const COMPANY_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_COMPANY_ID = "10000000-0000-4000-8000-000000000002";
const CONTACT_ID = "20000000-0000-4000-8000-000000000001";
const SOURCE_CONTACT_ID = "20000000-0000-4000-8000-000000000002";
const INTEGRATION_ID = "30000000-0000-4000-8000-000000000001";
const IDENTITY_ID = "40000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "50000000-0000-4000-8000-000000000001";
const PLAN_ID = "60000000-0000-4000-8000-000000000001";
const JOB_ID = "70000000-0000-4000-8000-000000000001";

type ManualOverride = {
  field: string;
  value: unknown;
  reason?: string;
  overriddenAt: string;
  overriddenBy: string;
};

type DatabaseTimestamp = Date | string;

function toIso(value: DatabaseTimestamp | null | undefined): string | null {
  if (value == null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describeDatabase("workspace server actions with Postgres", () => {
  const sql = postgres(databaseUrl!, {
    prepare: false,
    transform: postgres.camel,
  });

  beforeAll(async () => {
    await migrate(drizzle(sql), { migrationsFolder: "migrations" });
  });

  beforeEach(async () => {
    revalidatePathMock.mockClear();
    await sql`
      truncate table audit_events, analysis_results, analysis_jobs, touchpoints,
                     outreach_plans, messages, conversation_participants, conversations,
                     channel_identities, contacts, companies, integration_accounts
      restart identity cascade
    `;
  });

  afterAll(async () => {
    await closeDatabase();
    await sql.end();
  });

  it("persists contact and company additions, edits, corrections, overrides, and audits", async () => {
    const added = await addContact(
      form({
        displayName: "  Nora Fields  ",
        email: "nora@example.com",
        company: "Granite Works",
        title: "COO",
      }),
    );
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(added.error);

    const initialContacts = await sql<
      {
        id: string;
        companyId: string | null;
        displayName: string;
        primaryEmail: string | null;
        title: string | null;
        relationshipStage: string;
        notes: string | null;
        hasManualOverride: boolean;
        manualOverrides: ManualOverride[];
        metadata: Record<string, unknown>;
      }[]
    >`
      select id, company_id, display_name, primary_email, title, relationship_stage,
             notes, has_manual_override, manual_overrides, metadata
      from contacts where id = ${added.data.contactId}
    `;
    expect(initialContacts[0]).toMatchObject({
      displayName: "Nora Fields",
      primaryEmail: "nora@example.com",
      title: "COO",
      relationshipStage: "planned",
      notes: "Added manually. No source messages are attached yet.",
      hasManualOverride: true,
      metadata: { createdManually: true },
    });
    expect(initialContacts[0]?.manualOverrides).toHaveLength(6);
    expect(
      initialContacts[0]?.manualOverrides.every(
        (entry) => entry.overriddenBy === "owner@example.com",
      ),
    ).toBe(true);

    const createdCompanies = await sql<
      {
        id: string;
        name: string;
        normalizedName: string;
        confidence: number;
        hasManualOverride: boolean;
        manualOverrides: ManualOverride[];
        metadata: Record<string, unknown>;
      }[]
    >`
      select id, name, normalized_name, confidence, has_manual_override,
             manual_overrides, metadata
      from companies where id = ${added.data.companyId}
    `;
    expect(createdCompanies[0]).toMatchObject({
      name: "Granite Works",
      normalizedName: "granite works",
      confidence: 1,
      hasManualOverride: true,
      metadata: { createdManually: true },
    });
    expect(createdCompanies[0]?.manualOverrides[0]).toMatchObject({
      field: "name",
      value: "Granite Works",
      overriddenBy: "owner@example.com",
    });

    const edited = await editContact(
      added.data.contactId,
      form({
        displayName: "Nora F. Fields",
        email: "nora.fields@example.com",
        notes: "Met at the operations summit.",
      }),
    );
    expect(edited.ok).toBe(true);

    const corrected = await correctContact(
      added.data.contactId,
      "title",
      form({ value: "Chief Operating Officer", reason: "Confirmed by Nora." }),
    );
    expect(corrected.ok).toBe(true);

    const editedCompany = await editCompany(
      added.data.companyId!,
      form({
        name: "Granite Works, Inc.",
        domain: "granite.example",
        description: "Industrial operations software.",
      }),
    );
    expect(editedCompany.ok).toBe(true);

    const correctedCompany = await correctCompany(
      added.data.companyId!,
      "location",
      form({
        value: "Oakland, CA",
        reason: "Confirmed on the company profile.",
      }),
    );
    expect(correctedCompany.ok).toBe(true);

    const contacts = await sql<
      {
        displayName: string;
        primaryEmail: string | null;
        title: string | null;
        notes: string | null;
        manualOverrides: ManualOverride[];
      }[]
    >`
      select display_name, primary_email, title, notes, manual_overrides
      from contacts where id = ${added.data.contactId}
    `;
    expect(contacts[0]).toMatchObject({
      displayName: "Nora F. Fields",
      primaryEmail: "nora.fields@example.com",
      title: "Chief Operating Officer",
      notes: "Met at the operations summit.",
    });
    expect(contacts[0]?.manualOverrides[0]).toMatchObject({
      field: "title",
      value: "Chief Operating Officer",
      reason: "Confirmed by Nora.",
      overriddenBy: "owner@example.com",
    });
    expect(
      contacts[0]?.manualOverrides.slice(1, 4).map((entry) => entry.field),
    ).toEqual(["displayName", "primaryEmail", "notes"]);

    const companies = await sql<
      {
        name: string;
        normalizedName: string;
        domain: string | null;
        description: string | null;
        location: string | null;
        manualOverrides: ManualOverride[];
      }[]
    >`
      select name, normalized_name, domain, description, location, manual_overrides
      from companies where id = ${added.data.companyId}
    `;
    expect(companies[0]).toMatchObject({
      name: "Granite Works, Inc.",
      normalizedName: "granite works, inc.",
      domain: "granite.example",
      description: "Industrial operations software.",
      location: "Oakland, CA",
    });
    expect(companies[0]?.manualOverrides[0]).toMatchObject({
      field: "location",
      value: "Oakland, CA",
      reason: "Confirmed on the company profile.",
      overriddenBy: "owner@example.com",
    });

    const audits = await sql<
      {
        action: string;
        actorEmail: string;
        entityId: string | null;
        outcome: string;
      }[]
    >`
      select action, actor_email, entity_id, outcome
      from audit_events order by occurred_at, action
    `;
    expect(audits).toHaveLength(5);
    expect(audits.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "contact.created",
        "contact.edited",
        "contact.corrected",
        "company.edited",
        "company.corrected",
      ]),
    );
    expect(
      audits.every(
        (event) =>
          event.actorEmail === "owner@example.com" &&
          event.outcome === "success",
      ),
    ).toBe(true);

    const [personWorkspace, companyWorkspace] = await Promise.all([
      loadPersonWorkspaceData(added.data.contactId),
      loadCompanyWorkspaceData(added.data.companyId!),
    ]);
    expect(personWorkspace.people[0]).toMatchObject({
      id: added.data.contactId,
      displayName: "Nora F. Fields",
      notes: "Met at the operations summit.",
    });
    expect(personWorkspace.companies[0]).toMatchObject({
      id: added.data.companyId,
      name: "Granite Works, Inc.",
    });
    expect(companyWorkspace.companies[0]?.audit).toHaveLength(2);
    expect(companyWorkspace.people.map(({ id }) => id)).toEqual([
      added.data.contactId,
    ]);
  });

  it("creates, queues, reschedules, retries, and completes an outreach plan in the database", async () => {
    await seedContact(sql);

    const created = await upsertOutreachPlan(
      CONTACT_ID,
      null,
      form({
        objective: "Reconnect about the fall launch.",
        nextTouchAt: "2026-08-01",
        channel: "gmail",
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);

    const plansAfterCreate = await sql<
      {
        id: string;
        contactId: string;
        companyId: string | null;
        status: string;
        objective: string;
        preferredChannels: string[];
        nextTouchAt: DatabaseTimestamp | null;
        cadenceIntervalDays: number | null;
        plannedTouchCount: number;
        manualOverrides: ManualOverride[];
      }[]
    >`
      select id, contact_id, company_id, status, objective, preferred_channels,
             next_touch_at, cadence_interval_days, planned_touch_count, manual_overrides
      from outreach_plans where id = ${created.data.planId}
    `;
    expect(plansAfterCreate[0]).toMatchObject({
      contactId: CONTACT_ID,
      companyId: COMPANY_ID,
      status: "planned",
      objective: "Reconnect about the fall launch.",
      preferredChannels: ["gmail"],
      cadenceIntervalDays: 7,
      plannedTouchCount: 1,
    });
    expect(toIso(plansAfterCreate[0]?.nextTouchAt)).toBe(
      "2026-08-01T09:30:00.000Z",
    );
    expect(
      plansAfterCreate[0]?.manualOverrides.map((entry) => entry.field),
    ).toEqual(["objective", "preferredChannels", "nextTouchAt", "status"]);

    const contactAfterCreate = await sql<
      {
        relationshipStage: string;
        plannedFollowUpAt: DatabaseTimestamp | null;
        manualOverrides: ManualOverride[];
      }[]
    >`
      select relationship_stage, planned_follow_up_at, manual_overrides
      from contacts where id = ${CONTACT_ID}
    `;
    expect(contactAfterCreate[0]?.relationshipStage).toBe("planned");
    expect(toIso(contactAfterCreate[0]?.plannedFollowUpAt)).toBe(
      "2026-08-01T09:30:00.000Z",
    );
    expect(
      contactAfterCreate[0]?.manualOverrides
        .slice(0, 2)
        .map((entry) => entry.field),
    ).toEqual(["plannedFollowUpAt", "relationshipStage"]);

    const initialJobs = await sql<
      {
        id: string;
        status: string;
        jobType: string;
        entityType: string;
        entityId: string;
        runner: string;
        payload: Record<string, unknown>;
      }[]
    >`
      select id, status, job_type, entity_type, entity_id, runner, payload
      from analysis_jobs where entity_id = ${created.data.planId}
    `;
    expect(initialJobs).toHaveLength(1);
    expect(initialJobs[0]).toMatchObject({
      status: "queued",
      jobType: "draft_outreach",
      entityType: "outreach_plan",
      entityId: created.data.planId,
      runner: "codex-cli",
      payload: {
        planId: created.data.planId,
        contactId: CONTACT_ID,
        companyId: COMPANY_ID,
        objective: "Reconnect about the fall launch.",
        preferredChannels: ["gmail"],
        nextTouchAt: "2026-08-01T09:30:00.000Z",
        requestedBy: "owner@example.com",
        requestReason: "plan_saved",
      },
    });

    const rescheduled = await rescheduleOutreachPlan(
      created.data.planId,
      form({ date: "2026-08-08" }),
    );
    expect(rescheduled.ok).toBe(true);

    const plansAfterReschedule = await sql<
      {
        status: string;
        completedAt: DatabaseTimestamp | null;
        nextTouchAt: DatabaseTimestamp | null;
        manualOverrides: ManualOverride[];
      }[]
    >`
      select status, completed_at, next_touch_at, manual_overrides
      from outreach_plans where id = ${created.data.planId}
    `;
    expect(plansAfterReschedule[0]?.status).toBe("planned");
    expect(plansAfterReschedule[0]?.completedAt).toBeNull();
    expect(toIso(plansAfterReschedule[0]?.nextTouchAt)).toBe(
      "2026-08-08T09:30:00.000Z",
    );
    expect(
      plansAfterReschedule[0]?.manualOverrides
        .slice(0, 2)
        .map((entry) => entry.field),
    ).toEqual(["nextTouchAt", "status"]);

    const retried = await retryOutreachDraft(created.data.planId);
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error(retried.error);

    const retryJobs = await sql<
      {
        id: string;
        status: string;
        entityId: string;
        payload: Record<string, unknown>;
      }[]
    >`
      select id, status, entity_id, payload from analysis_jobs where id = ${retried.data.jobId}
    `;
    expect(retryJobs[0]).toMatchObject({
      id: retried.data.jobId,
      status: "queued",
      entityId: created.data.planId,
      payload: {
        planId: created.data.planId,
        contactId: CONTACT_ID,
        requestReason: "owner_retry",
        requestedBy: "owner@example.com",
        nextTouchAt: "2026-08-08T09:30:00.000Z",
      },
    });
    const jobCounts = await sql<{ count: number }[]>`
      select count(*)::int as count from analysis_jobs where entity_id = ${created.data.planId}
    `;
    expect(jobCounts[0]?.count).toBe(2);

    const completed = await completeOutreachPlan(created.data.planId);
    expect(completed.ok).toBe(true);

    const plansAfterComplete = await sql<
      {
        status: string;
        completedAt: DatabaseTimestamp | null;
        manualOverrides: ManualOverride[];
      }[]
    >`
      select status, completed_at, manual_overrides
      from outreach_plans where id = ${created.data.planId}
    `;
    expect(plansAfterComplete[0]?.status).toBe("completed");
    expect(toIso(plansAfterComplete[0]?.completedAt)).not.toBeNull();
    expect(
      plansAfterComplete[0]?.manualOverrides
        .slice(0, 2)
        .map((entry) => entry.field),
    ).toEqual(["status", "completedAt"]);
    expect(plansAfterComplete[0]?.manualOverrides[0]).toMatchObject({
      value: "completed",
      overriddenBy: "owner@example.com",
    });

    const contactsAfterComplete = await sql<
      {
        plannedFollowUpAt: DatabaseTimestamp | null;
        manualOverrides: ManualOverride[];
      }[]
    >`
      select planned_follow_up_at, manual_overrides from contacts where id = ${CONTACT_ID}
    `;
    expect(contactsAfterComplete[0]?.plannedFollowUpAt).toBeNull();
    expect(contactsAfterComplete[0]?.manualOverrides[0]).toMatchObject({
      field: "plannedFollowUpAt",
      value: null,
      overriddenBy: "owner@example.com",
    });

    const audits = await sql<{ action: string; actorEmail: string }[]>`
      select action, actor_email from audit_events order by occurred_at, action
    `;
    expect(audits).toHaveLength(4);
    expect(audits.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "outreach_plan.created",
        "outreach_plan.rescheduled",
        "outreach_plan.draft_retried",
        "outreach_plan.completed",
      ]),
    );
    expect(
      audits.every((event) => event.actorEmail === "owner@example.com"),
    ).toBe(true);
  });

  it("merges contacts while reparenting dependent rows and preserving provenance, overrides, and audit history", async () => {
    await seedMergeGraph(sql);

    const merged = await mergeContacts(SOURCE_CONTACT_ID, CONTACT_ID);
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error(merged.error);

    const contacts = await sql<
      {
        id: string;
        companyId: string | null;
        givenName: string | null;
        primaryEmail: string | null;
        title: string | null;
        location: string | null;
        replyState: string;
        firstTouchAt: DatabaseTimestamp | null;
        lastTouchAt: DatabaseTimestamp | null;
        lastInboundAt: DatabaseTimestamp | null;
        lastOutboundAt: DatabaseTimestamp | null;
        touchCount: number;
        inboundTouchCount: number;
        outboundTouchCount: number;
        notes: string | null;
        confidence: number;
        sourceProvenance: Array<Record<string, unknown>>;
        manualOverrides: ManualOverride[];
        metadata: { mergedContactIds?: string[] };
      }[]
    >`
      select id, company_id, given_name, primary_email, title, location, reply_state,
             first_touch_at, last_touch_at, last_inbound_at, last_outbound_at,
             touch_count, inbound_touch_count, outbound_touch_count, notes, confidence,
             source_provenance, manual_overrides, metadata
      from contacts order by id
    `;
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      id: CONTACT_ID,
      companyId: COMPANY_ID,
      givenName: "Source",
      primaryEmail: "source@example.com",
      title: "VP Sales",
      location: "Portland, OR",
      replyState: "replied",
      touchCount: 2,
      inboundTouchCount: 1,
      outboundTouchCount: 1,
      notes: "Target note.\n\nSource note.",
      confidence: 0.9,
    });
    expect(toIso(contacts[0]?.firstTouchAt)).toBe("2026-07-01T12:00:00.000Z");
    expect(toIso(contacts[0]?.lastTouchAt)).toBe("2026-07-03T12:00:00.000Z");
    expect(toIso(contacts[0]?.lastInboundAt)).toBe("2026-07-01T12:00:00.000Z");
    expect(toIso(contacts[0]?.lastOutboundAt)).toBe("2026-07-03T12:00:00.000Z");
    expect(contacts[0]?.sourceProvenance).toHaveLength(2);
    expect(contacts[0]?.manualOverrides.map((entry) => entry.field)).toEqual([
      "mergedContactIds",
      "targetNote",
      "sourceTitle",
    ]);
    expect(contacts[0]?.manualOverrides[0]).toMatchObject({
      value: [SOURCE_CONTACT_ID],
      overriddenBy: "owner@example.com",
    });
    expect(contacts[0]?.metadata.mergedContactIds).toEqual([
      "20000000-0000-4000-8000-000000000099",
      SOURCE_CONTACT_ID,
      "20000000-0000-4000-8000-000000000098",
    ]);

    const identities = await sql<{ contactId: string | null }[]>`
      select contact_id from channel_identities where id = ${IDENTITY_ID}
    `;
    const participants = await sql<{ contactId: string | null }[]>`
      select contact_id from conversation_participants where conversation_id = ${CONVERSATION_ID}
    `;
    const touchpoints = await sql<{ contactId: string }[]>`
      select contact_id from touchpoints order by happened_at
    `;
    const plans = await sql<{ contactId: string }[]>`
      select contact_id from outreach_plans where id = ${PLAN_ID}
    `;
    const jobs = await sql<{ entityId: string }[]>`
      select entity_id from analysis_jobs where id = ${JOB_ID}
    `;
    const results = await sql<{ entityId: string }[]>`
      select entity_id from analysis_results where job_id = ${JOB_ID}
    `;
    expect(identities[0]?.contactId).toBe(CONTACT_ID);
    expect(participants[0]?.contactId).toBe(CONTACT_ID);
    expect(touchpoints.map((row) => row.contactId)).toEqual([
      CONTACT_ID,
      CONTACT_ID,
    ]);
    expect(plans[0]?.contactId).toBe(CONTACT_ID);
    expect(jobs[0]?.entityId).toBe(CONTACT_ID);
    expect(results[0]?.entityId).toBe(CONTACT_ID);

    const audits = await sql<
      {
        action: string;
        actorEmail: string;
        entityId: string | null;
        metadata: Record<string, unknown>;
      }[]
    >`
      select action, actor_email, entity_id, metadata from audit_events order by occurred_at, action
    `;
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: "contact.seeded",
      entityId: CONTACT_ID,
    });
    expect(audits[1]).toMatchObject({
      action: "contact.merged",
      actorEmail: "owner@example.com",
      entityId: CONTACT_ID,
      metadata: {
        sourceContactId: SOURCE_CONTACT_ID,
        sourceDisplayName: "Source Person",
        targetContactId: CONTACT_ID,
        targetDisplayName: "Target Person",
      },
    });
  });
});

async function seedContact(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    insert into companies (id, name, normalized_name, confidence)
    values (${COMPANY_ID}, 'Arcminute', 'arcminute', 0.8)
  `;
  await sql`
    insert into contacts (id, company_id, display_name, primary_email, relationship_stage, confidence)
    values (${CONTACT_ID}, ${COMPANY_ID}, 'Priya Shah', 'priya@example.com', 'active', 0.9)
  `;
}

async function seedMergeGraph(sql: ReturnType<typeof postgres>): Promise<void> {
  const targetProvenance = [
    {
      provider: "gmail",
      integrationAccountId: INTEGRATION_ID,
      externalId: "shared-message",
      collectedAt: "2026-07-01T12:00:00.000Z",
      confidence: 1,
      metadata: {},
    },
  ];
  const sourceProvenance = [
    ...targetProvenance,
    {
      provider: "linkedin",
      integrationAccountId: null,
      externalId: "source-profile",
      collectedAt: "2026-07-02T12:00:00.000Z",
      confidence: 0.9,
      metadata: {},
    },
  ];
  const targetOverrides = [
    {
      field: "targetNote",
      value: "Target note.",
      reason: "Owner note.",
      overriddenAt: "2026-07-10T12:00:00.000Z",
      overriddenBy: "owner@example.com",
    },
  ];
  const sourceOverrides = [
    {
      field: "sourceTitle",
      value: "VP Sales",
      reason: "Owner correction.",
      overriddenAt: "2026-07-11T12:00:00.000Z",
      overriddenBy: "owner@example.com",
    },
  ];

  await sql`
    insert into companies (id, name, normalized_name, confidence) values
      (${COMPANY_ID}, 'Target Co', 'target co', 0.7),
      (${SOURCE_COMPANY_ID}, 'Source Co', 'source co', 0.7)
  `;
  await sql`
    insert into integration_accounts (
      id, provider, external_account_id, display_name, account_email, status,
      credential_ciphertext, connected_at
    ) values (
      ${INTEGRATION_ID}, 'gmail', 'owner@example.com', 'Owner Gmail',
      'owner@example.com', 'connected', 'sealed-test-credential', now()
    )
  `;
  await sql`
    insert into contacts (
      id, company_id, display_name, reply_state, notes, confidence,
      source_provenance, has_manual_override, manual_overrides, metadata
    ) values (
      ${CONTACT_ID}, ${COMPANY_ID}, 'Target Person', 'unknown', 'Target note.', 0.5,
      ${JSON.stringify(targetProvenance)}::jsonb, true, ${JSON.stringify(targetOverrides)}::jsonb,
      ${JSON.stringify({ mergedContactIds: ["20000000-0000-4000-8000-000000000099"] })}::jsonb
    ), (
      ${SOURCE_CONTACT_ID}, ${SOURCE_COMPANY_ID}, 'Source Person', 'replied', 'Source note.', 0.9,
      ${JSON.stringify(sourceProvenance)}::jsonb, true, ${JSON.stringify(sourceOverrides)}::jsonb,
      ${JSON.stringify({ mergedContactIds: ["20000000-0000-4000-8000-000000000098"] })}::jsonb
    )
  `;
  await sql`
    update contacts set given_name = 'Source', primary_email = 'source@example.com',
      title = 'VP Sales', location = 'Portland, OR'
    where id = ${SOURCE_CONTACT_ID}
  `;
  await sql`
    insert into channel_identities (
      id, contact_id, integration_account_id, channel, external_id, address
    ) values (
      ${IDENTITY_ID}, ${SOURCE_CONTACT_ID}, ${INTEGRATION_ID}, 'gmail',
      'source@example.com', 'source@example.com'
    )
  `;
  await sql`
    insert into conversations (
      id, integration_account_id, channel, external_conversation_id, idempotency_key
    ) values (
      ${CONVERSATION_ID}, ${INTEGRATION_ID}, 'gmail', 'merge-conversation',
      'merge-conversation-key'
    )
  `;
  await sql`
    insert into conversation_participants (
      conversation_id, channel_identity_id, contact_id, external_participant_id, role
    ) values (
      ${CONVERSATION_ID}, ${IDENTITY_ID}, ${SOURCE_CONTACT_ID}, 'source@example.com', 'other'
    )
  `;
  await sql`
    insert into outreach_plans (
      id, contact_id, company_id, status, objective, preferred_channels, next_touch_at
    ) values (
      ${PLAN_ID}, ${SOURCE_CONTACT_ID}, ${SOURCE_COMPANY_ID}, 'planned',
      'Follow up after merge', array['gmail']::channel[], '2026-07-20T12:00:00.000Z'
    )
  `;
  await sql`
    insert into touchpoints (
      contact_id, company_id, outreach_plan_id, idempotency_key, channel,
      direction, kind, happened_at, is_automated
    ) values (
      ${SOURCE_CONTACT_ID}, ${SOURCE_COMPANY_ID}, ${PLAN_ID}, 'source-touch',
      'gmail', 'inbound', 'message', '2026-07-01T12:00:00.000Z', true
    ), (
      ${CONTACT_ID}, ${COMPANY_ID}, null, 'target-touch',
      'linkedin', 'outbound', 'message', '2026-07-03T12:00:00.000Z', true
    )
  `;
  await sql`
    insert into analysis_jobs (
      id, idempotency_key, job_type, status, entity_type, entity_id, input_hash,
      runner, schema_version, payload, scheduled_at
    ) values (
      ${JOB_ID}, 'merge-analysis-job', 'extract_contact', 'succeeded',
      'contact', ${SOURCE_CONTACT_ID}, 'merge-input-hash', 'codex-cli', 1,
      '{}'::jsonb, '2026-07-05T12:00:00.000Z'
    )
  `;
  await sql`
    insert into analysis_results (
      job_id, entity_type, entity_id, result_type, schema_version, result, confidence
    ) values (
      ${JOB_ID}, 'contact', ${SOURCE_CONTACT_ID}, 'relationship_analysis', 1,
      '{}'::jsonb, 0.8
    )
  `;
  await sql`
    insert into audit_events (
      action, outcome, actor_email, entity_type, entity_id, metadata, occurred_at
    ) values (
      'contact.seeded', 'success', 'seed@example.com', 'contact', ${SOURCE_CONTACT_ID},
      '{}'::jsonb, '2026-07-06T12:00:00.000Z'
    )
  `;
}
