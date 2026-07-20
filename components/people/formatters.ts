import type { Channel, ReplyState } from "@/lib/domain/constants";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDate(value: string | null) {
  return value ? dateFormatter.format(new Date(value)) : "Not yet";
}

export function formatDateTime(value: string | null) {
  return value ? dateTimeFormatter.format(new Date(value)) : "Not scheduled";
}

export function formatRelativeDate(value: string | null, referenceNow: string) {
  if (!value) return "No activity";

  const dayMs = 24 * 60 * 60 * 1000;
  const deltaDays = Math.round(
    (new Date(value).getTime() - new Date(referenceNow).getTime()) / dayMs,
  );

  if (deltaDays === 0) return "Today";
  if (deltaDays === 1) return "Tomorrow";
  if (deltaDays === -1) return "Yesterday";
  if (deltaDays > 1 && deltaDays < 7) return `In ${deltaDays} days`;
  if (deltaDays < -1 && deltaDays > -7)
    return `${Math.abs(deltaDays)} days ago`;
  return formatDate(value);
}

// Compact past-tense distance for card-level scanning ("3h ago", "2w ago").
// Sub-day precision matters here: "Today" hides whether a reply landed ten
// minutes or ten hours ago.
export function formatTimeAgo(value: string | null, referenceNow: string) {
  if (!value) return "never";
  const deltaMs = new Date(referenceNow).getTime() - new Date(value).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  const months = Math.round(days / 30.4);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export interface FollowUpStatus {
  label: string;
  tone: "positive" | "attention" | "neutral";
}

// One human-readable line answering "where does this thread stand and how
// long has it been?" — whose move it is drives the tone.
export function followUpStatus(
  person: {
    replyState: ReplyState;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    lastTouchAt: string | null;
  },
  referenceNow: string,
): FollowUpStatus {
  const inboundAt = person.lastInboundAt
    ? new Date(person.lastInboundAt).getTime()
    : null;
  const outboundAt = person.lastOutboundAt
    ? new Date(person.lastOutboundAt).getTime()
    : null;

  if (person.replyState === "awaiting_reply" && person.lastOutboundAt) {
    const waitingDays =
      (new Date(referenceNow).getTime() - (outboundAt ?? 0)) /
      (24 * 60 * 60 * 1000);
    return {
      label: `You followed up ${formatTimeAgo(person.lastOutboundAt, referenceNow)} · no reply yet`,
      tone: waitingDays >= 7 ? "attention" : "neutral",
    };
  }
  if (person.replyState === "replied") {
    if (inboundAt && (!outboundAt || inboundAt > outboundAt)) {
      return {
        label: `They replied ${formatTimeAgo(person.lastInboundAt, referenceNow)} · your turn`,
        tone: "positive",
      };
    }
    if (person.lastOutboundAt) {
      return {
        label: `You replied ${formatTimeAgo(person.lastOutboundAt, referenceNow)}`,
        tone: "neutral",
      };
    }
  }
  if (person.lastTouchAt) {
    return {
      label: `Last touch ${formatTimeAgo(person.lastTouchAt, referenceNow)}`,
      tone: "neutral",
    };
  }
  return { label: "No activity yet", tone: "neutral" };
}

// Deterministic pastel identity color so the same person is always the same
// hue across views.
export function avatarHue(displayName: string) {
  let hash = 0;
  for (const char of displayName) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

export function confidenceLabel(confidence: number) {
  if (confidence >= 0.9) return "High confidence";
  if (confidence >= 0.7) return "Review suggested";
  return "Needs review";
}

export function replyLabel(replyState: ReplyState) {
  switch (replyState) {
    case "awaiting_reply":
      return "Awaiting reply";
    case "replied":
      return "Replied";
    case "not_applicable":
      return "Not applicable";
    case "unknown":
      return "Reply unknown";
  }
}

export function channelLabel(channel: Channel | "internal") {
  if (channel === "gmail") return "Gmail";
  if (channel === "linkedin") return "LinkedIn";
  if (channel === "x") return "X";
  return "Threadline";
}

export function initials(displayName: string) {
  return displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.at(0)?.toUpperCase())
    .join("");
}

// Heuristic: is this address an automated / bulk sender rather than a person?
export function isNoiseEmail(email: string | null | undefined): boolean {
  if (!email) return false; // manual contacts with no email are kept
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  const localNoise =
    /(^|[.\-_+])(no-?reply|do-?not-?reply|donotreply|noreply|notifications?|notify|mailer-daemon|postmaster|bounces?|newsletters?|updates?|digest|alerts?|mailer|automated?|marketing)($|[.\-_+])/;
  // Bulk-email subdomains only match at the START of the domain (so a real
  // domain like "acme.io" is never misread as noise).
  const domainNoise =
    /^(?:em|e|mail|mailer|news|newsletter|reply|notifications?|notify|marketing|bounce)\.|(?:mailchimp|sendgrid|sparkpost|amazonses|mailgun|postmark|substack|sendinblue|mandrill|customer\.io)/;
  return localNoise.test(local) || domainNoise.test(domain);
}

// Derive from/to for a message from its direction and the related person.
export function emailParties(
  direction: "inbound" | "outbound" | "internal",
  personName: string,
  personEmail: string | null,
): { from: string; to: string } {
  const contact = personEmail ? `${personName} <${personEmail}>` : personName;
  if (direction === "outbound") return { from: "You", to: contact };
  if (direction === "inbound") return { from: contact, to: "You" };
  return { from: contact, to: "" };
}
