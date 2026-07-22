import { z } from "zod";

// One cheap-model pass per conversation: a single at-a-glance sentence plus a
// coarse kind label. Inputs are the subjects and snippets Threadline already
// stores — never full message bodies, and nothing is logged.
export const conversationDigestSchema = z.object({
  summary: z.string().min(1).max(200),
  kind: z.enum([
    "outreach",
    "vendor",
    "recruiting",
    "personal",
    "internal",
    "bulk",
    "other",
  ]),
});

export type ConversationDigest = z.infer<typeof conversationDigestSchema>;

export interface DigestMessage {
  direction: string;
  at: string;
  subject: string | null;
  snippet: string | null;
}

export interface DigestInput {
  displayName: string;
  primaryEmail: string | null;
  messages: DigestMessage[];
}

const MAX_MESSAGES = 8;

function clip(value: string | null, max: number): string {
  if (!value) return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function buildDigestPrompt(input: DigestInput): string {
  const lines = input.messages
    .slice(0, MAX_MESSAGES)
    .map((message) => {
      const arrow =
        message.direction === "outbound"
          ? "me →"
          : message.direction === "inbound"
            ? "→ me"
            : "•";
      return `${message.at.slice(0, 10)} ${arrow} | ${clip(message.subject, 90)} | ${clip(message.snippet, 220)}`;
    })
    .join("\n");

  const contactLabel = input.primaryEmail
    ? `${input.displayName} <${input.primaryEmail}>`
    : input.displayName;

  return [
    'You label email conversations for a personal outreach CRM. "me" is the CRM owner; the contact is the other party.',
    `Contact: ${contactLabel}`,
    "Messages (newest first, subject | snippet):",
    lines,
    "",
    "Produce:",
    "- summary: ONE plain sentence, at most 140 characters, giving the at-a-glance gist of what this thread is about and where it stands (e.g. \"Cold pitch about the prod-regression agent; two follow-ups, no reply yet.\").",
    "- kind: outreach (me pitching or cold-emailing them), vendor (them selling to me), recruiting, personal, internal (teammate), bulk (automated/newsletter), or other.",
  ].join("\n");
}
