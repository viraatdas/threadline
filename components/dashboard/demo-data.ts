import type { DashboardSnapshot } from "@/components/dashboard/types";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

function ago(now: Date, milliseconds: number) {
  return new Date(now.getTime() - milliseconds).toISOString();
}

function ahead(now: Date, milliseconds: number) {
  return new Date(now.getTime() + milliseconds).toISOString();
}

export function createDashboardDemoData(now = new Date()): DashboardSnapshot {
  return {
    generatedAt: now.toISOString(),
    metrics: {
      planned: 12,
      followUpsDue: 4,
      contacted: 38,
      replied: 17,
      unreplied: 21,
      replyRate: 45,
    },
    nextActions: [
      {
        id: "demo-action-1",
        contactId: "demo-contact-1",
        contactName: "Maya Chen",
        companyName: "Northstar Labs",
        role: "VP, Customer Experience",
        channel: "gmail",
        kind: "follow_up",
        urgency: "overdue",
        dueAt: ago(now, DAY),
        lastTouchAt: ago(now, 8 * DAY),
        touchCount: 2,
        rationale:
          "Maya opened with a specific onboarding pain point, then went quiet after asking for examples.",
        rationaleSource: "model",
        confidence: 0.91,
        suggestedDraft:
          "Maya — I pulled together two concise onboarding examples that mirror the workflow you described. Happy to send them over if the timing is still useful.",
      },
      {
        id: "demo-action-2",
        contactId: "demo-contact-2",
        contactName: "Jon Bell",
        companyName: "Parcel",
        role: "Founder",
        channel: "linkedin",
        kind: "planned_outreach",
        urgency: "today",
        dueAt: ahead(now, 3 * HOUR),
        lastTouchAt: null,
        touchCount: 0,
        rationale:
          "Parcel is hiring its first success lead, which makes the relationship-memory angle timely.",
        rationaleSource: "model",
        confidence: 0.84,
        suggestedDraft:
          "Jon — noticed Parcel is building out customer success. I’m working on a quieter way to keep outreach and relationship context connected across channels.",
      },
      {
        id: "demo-action-3",
        contactId: "demo-contact-3",
        contactName: "Priya Raman",
        companyName: "Fieldwork",
        role: "Head of Revenue Operations",
        channel: "x",
        kind: "awaiting_reply",
        urgency: "watch",
        dueAt: null,
        lastTouchAt: ago(now, 5 * DAY),
        touchCount: 1,
        rationale:
          "The first note was relevant and recent; wait two more days before considering a follow-up.",
        rationaleSource: "model",
        confidence: 0.78,
        suggestedDraft: null,
      },
      {
        id: "demo-action-4",
        contactId: "demo-contact-4",
        contactName: "Elena Torres",
        companyName: "Arcade Health",
        role: "COO",
        channel: "gmail",
        kind: "follow_up",
        urgency: "upcoming",
        dueAt: ahead(now, DAY),
        lastTouchAt: ago(now, 12 * DAY),
        touchCount: 3,
        rationale:
          "Elena replied positively but asked to revisit after the quarterly planning cycle.",
        rationaleSource: "model",
        confidence: 0.88,
        suggestedDraft:
          "Elena — circling back after your planning cycle as promised. Has the team’s view on cross-channel relationship tracking changed at all?",
      },
    ],
    channelMix: [
      { channel: "gmail", count: 24, share: 63 },
      { channel: "linkedin", count: 9, share: 24 },
      { channel: "x", count: 5, share: 13 },
    ],
    staleRelationships: [
      {
        contactId: "demo-contact-5",
        contactName: "Theo Martin",
        companyName: "Goodmeasure",
        role: "Product Lead",
        replyState: "replied",
        lastTouchAt: ago(now, 43 * DAY),
        touchCount: 6,
      },
      {
        contactId: "demo-contact-6",
        contactName: "Nadia Patel",
        companyName: "Hearthside",
        role: "Co-founder",
        replyState: "awaiting_reply",
        lastTouchAt: ago(now, 31 * DAY),
        touchCount: 2,
      },
      {
        contactId: "demo-contact-7",
        contactName: "Marcus Lee",
        companyName: "Operand",
        role: "Customer Success Director",
        replyState: "unknown",
        lastTouchAt: ago(now, 27 * DAY),
        touchCount: 1,
      },
    ],
    recentConversations: [
      {
        id: "demo-conversation-1",
        contactId: "demo-contact-8",
        contactName: "Sasha Kim",
        companyName: "Common Room",
        channel: "gmail",
        subject: "Re: relationship context across channels",
        preview:
          "This is close to how we think about signal quality — curious how you resolve identity…",
        lastMessageAt: ago(now, 38 * 60 * 1_000),
        replyState: "replied",
        touchCount: 4,
      },
      {
        id: "demo-conversation-2",
        contactId: "demo-contact-2",
        contactName: "Jon Bell",
        companyName: "Parcel",
        channel: "linkedin",
        subject: null,
        preview:
          "Thanks for reaching out — the timing might be good once our CS hire starts.",
        lastMessageAt: ago(now, 7 * HOUR),
        replyState: "replied",
        touchCount: 3,
      },
      {
        id: "demo-conversation-3",
        contactId: "demo-contact-3",
        contactName: "Priya Raman",
        companyName: "Fieldwork",
        channel: "x",
        subject: null,
        preview:
          "Sent a short note about keeping founder-led outreach context intact.",
        lastMessageAt: ago(now, 5 * DAY),
        replyState: "awaiting_reply",
        touchCount: 1,
      },
      {
        id: "demo-conversation-4",
        contactId: "demo-contact-4",
        contactName: "Elena Torres",
        companyName: "Arcade Health",
        channel: "gmail",
        subject: "Re: lightweight relationship memory",
        preview:
          "Let’s pick this up after planning — the source evidence piece matters to me.",
        lastMessageAt: ago(now, 12 * DAY),
        replyState: "replied",
        touchCount: 3,
      },
    ],
    syncHealth: [
      {
        id: "demo-sync-gmail",
        channel: "gmail",
        displayName: "Gmail",
        status: "healthy",
        statusLabel: "Current",
        lastSyncedAt: ago(now, 6 * 60 * 1_000),
        detail: "42 threads checked; 3 updated",
      },
      {
        id: "demo-sync-linkedin",
        channel: "linkedin",
        displayName: "LinkedIn",
        status: "healthy",
        statusLabel: "Current",
        lastSyncedAt: ago(now, 18 * 60 * 1_000),
        detail: "18 conversations checked; no changes",
      },
      {
        id: "demo-sync-x",
        channel: "x",
        displayName: "X",
        status: "attention",
        statusLabel: "Needs attention",
        lastSyncedAt: ago(now, 9 * HOUR),
        detail: "Session cookie needs to be refreshed",
      },
    ],
    analysisHealth: {
      status: "working",
      queued: 7,
      running: 1,
      failed: 0,
      succeeded: 146,
      oldestQueuedAt: ago(now, 11 * 60 * 1_000),
      detail: "Codex worker is classifying 8 new or changed threads",
    },
  };
}
