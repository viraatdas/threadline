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
