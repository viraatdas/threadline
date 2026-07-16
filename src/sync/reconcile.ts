import type { Channel, ReplyState } from "@/lib/domain/constants";

export interface ReconcileContactCandidate {
  id: string;
  primaryEmail: string | null;
  companyId: string | null;
  hasManualOverride: boolean;
  createdAt: Date;
}

export interface ReconcileIdentityCandidate {
  contactId: string | null;
  channel: Channel;
  address: string | null;
  isOwner: boolean;
}

export interface ContactMergePlan {
  email: string;
  canonicalContactId: string;
  duplicateContactIds: string[];
}

export interface RelationshipAggregate {
  touchCount: number;
  inboundTouchCount: number;
  outboundTouchCount: number;
  firstTouchAt: Date | null;
  lastTouchAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
}

export interface RelationshipMetrics extends RelationshipAggregate {
  replyState: ReplyState;
  relationshipStage: "unreviewed" | "active" | "waiting" | "replied";
}

export interface AnalysisCoverageCandidate {
  jobType: string;
  inputHash: string;
  messageExternalIds: readonly string[];
}

export interface ExistingAnalysisJob {
  jobType: string;
  inputHash: string;
  payload: Record<string, unknown>;
}

export function planConservativeIdentityMerges(
  contacts: readonly ReconcileContactCandidate[],
  identities: readonly ReconcileIdentityCandidate[],
): ContactMergePlan[] {
  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
  const emailsByContact = new Map<string, Set<string>>();
  const authoritativeContacts = new Set<string>();

  for (const contact of contacts) {
    const email = normalizeIdentityEmail(contact.primaryEmail);
    if (!email) continue;
    addEmail(emailsByContact, contact.id, email);
    authoritativeContacts.add(contact.id);
  }

  for (const identity of identities) {
    if (!identity.contactId || identity.isOwner) continue;
    const email = normalizeIdentityEmail(identity.address);
    if (!email) continue;
    addEmail(emailsByContact, identity.contactId, email);
    if (identity.channel === "gmail")
      authoritativeContacts.add(identity.contactId);
  }

  const contactsByEmail = new Map<string, ReconcileContactCandidate[]>();
  for (const [contactId, emails] of emailsByContact) {
    const contact = contactById.get(contactId);
    if (
      !contact ||
      contact.hasManualOverride ||
      emails.size !== 1 ||
      !authoritativeContacts.has(contactId)
    )
      continue;
    const email = [...emails][0]!;
    const group = contactsByEmail.get(email) ?? [];
    group.push(contact);
    contactsByEmail.set(email, group);
  }

  const plans: ContactMergePlan[] = [];
  for (const [email, group] of contactsByEmail) {
    if (group.length < 2) continue;
    const companyIds = new Set(
      group
        .map((contact) => contact.companyId)
        .filter((value): value is string => Boolean(value)),
    );
    if (companyIds.size > 1) continue;
    const sorted = [...group].sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
    plans.push({
      email,
      canonicalContactId: sorted[0]!.id,
      duplicateContactIds: sorted.slice(1).map((contact) => contact.id),
    });
  }

  return plans.sort((left, right) => left.email.localeCompare(right.email));
}

export function deriveRelationshipMetrics(
  aggregate: RelationshipAggregate | undefined,
): RelationshipMetrics {
  const values = aggregate ?? {
    touchCount: 0,
    inboundTouchCount: 0,
    outboundTouchCount: 0,
    firstTouchAt: null,
    lastTouchAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
  const replyState: ReplyState = values.lastOutboundAt
    ? values.lastInboundAt && values.lastInboundAt > values.lastOutboundAt
      ? "replied"
      : "awaiting_reply"
    : values.lastInboundAt
      ? "not_applicable"
      : "unknown";
  const relationshipStage =
    values.touchCount === 0
      ? "unreviewed"
      : replyState === "replied"
        ? "replied"
        : replyState === "awaiting_reply"
          ? "waiting"
          : "active";
  return { ...values, replyState, relationshipStage };
}

export function isAnalysisCovered(
  candidate: AnalysisCoverageCandidate,
  jobs: readonly ExistingAnalysisJob[],
): boolean {
  return jobs.some((job) => {
    if (job.jobType !== candidate.jobType) return false;
    if (job.inputHash === candidate.inputHash) return true;
    const payloadIds = payloadMessageExternalIds(job.payload);
    return sameStrings(payloadIds, candidate.messageExternalIds);
  });
}

export function normalizeIdentityEmail(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 320) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)
    ? normalized
    : undefined;
}

function addEmail(
  target: Map<string, Set<string>>,
  contactId: string,
  email: string,
) {
  const values = target.get(contactId) ?? new Set<string>();
  values.add(email);
  target.set(contactId, values);
}

function payloadMessageExternalIds(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.messages)) return [];
  return payload.messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    const externalId = (message as Record<string, unknown>).externalMessageId;
    return typeof externalId === "string" ? [externalId] : [];
  });
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every(
    (value, index) => value === normalizedRight[index],
  );
}
