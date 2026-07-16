import type { GmailMessagePart } from "@/src/integrations/gmail/types";

export interface GmailAttachmentMetadata {
  attachmentId?: string;
  filename?: string;
  mimeType?: string;
  size: number;
  partId?: string;
}

export interface NormalizedGmailBody {
  bodyText?: string;
  bodyHtml?: string;
  attachments: GmailAttachmentMetadata[];
}

export function normalizeGmailBody(
  payload: GmailMessagePart | null | undefined,
): NormalizedGmailBody {
  if (!payload) return { attachments: [] };
  const attachments: GmailAttachmentMetadata[] = [];
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  collectParts(payload, attachments, textParts, htmlParts);

  const bodyHtml =
    htmlParts.length > 0 ? trimQuotedHtml(htmlParts.join("\n")) : undefined;
  const plainText =
    textParts.length > 0
      ? textParts.join("\n")
      : bodyHtml
        ? htmlToText(bodyHtml)
        : undefined;
  const bodyText = plainText
    ? trimQuotedText(normalizeText(plainText)).slice(0, 1_000_000)
    : undefined;
  const normalizedHtml = bodyHtml?.trim().slice(0, 2_000_000);

  return {
    ...(bodyText ? { bodyText } : {}),
    ...(normalizedHtml ? { bodyHtml: normalizedHtml } : {}),
    attachments,
  };
}

export function trimQuotedText(value: string): string {
  const lines = value.split("\n");
  let cutoff = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (index === 0) continue;
    if (/^On .{3,} wrote:$/i.test(line)) cutoff = index;
    if (/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i.test(line))
      cutoff = index;
    if (/^_{8,}$/.test(line)) cutoff = index;
    if (
      /^From:\s+.+/i.test(line) &&
      lines
        .slice(index, index + 6)
        .some((next) => /^Subject:/i.test(next.trim()))
    ) {
      cutoff = index;
    }
    if (
      /^>/.test(line) &&
      lines
        .slice(index)
        .filter((next) => next.trim().length > 0)
        .every((next) => /^>/.test(next.trim()))
    ) {
      cutoff = index;
    }
    if (cutoff !== lines.length) break;
  }
  return lines.slice(0, cutoff).join("\n").trim();
}

export function trimQuotedHtml(value: string): string {
  return value
    .replace(
      /<div\b[^>]*class=["'][^"']*gmail_attr[^"']*["'][^>]*>[\s\S]*$/i,
      "",
    )
    .replace(
      /<div\b[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*$/i,
      "",
    )
    .replace(/<blockquote\b[^>]*>[\s\S]*$/i, "")
    .trim();
}

function collectParts(
  part: GmailMessagePart,
  attachments: GmailAttachmentMetadata[],
  textParts: string[],
  htmlParts: string[],
): void {
  const mimeType = part.mimeType?.toLowerCase() ?? "";
  const filename = part.filename?.trim();
  const attachmentId = part.body?.attachmentId?.trim();
  if (attachmentId || filename) {
    attachments.push({
      ...(attachmentId ? { attachmentId } : {}),
      ...(filename ? { filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      size: part.body?.size ?? 0,
      ...(part.partId ? { partId: part.partId } : {}),
    });
    return;
  }

  const decoded = decodeBodyData(part.body?.data);
  if (decoded && mimeType === "text/plain") textParts.push(decoded);
  if (decoded && mimeType === "text/html") htmlParts.push(decoded);
  for (const child of part.parts ?? [])
    collectParts(child, attachments, textParts, htmlParts);
}

function decodeBodyData(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}
