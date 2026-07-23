import { generateObject } from "ai";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db/client";
import { contacts, messages, touchpoints } from "@/lib/db/schema";
import {
  buildDigestPrompt,
  conversationDigestSchema,
} from "@/src/enrichment/digest";
import { extractSignatureFacts } from "@/src/enrichment/signature";
import { isAuthorizedCronRequest } from "@/src/sync/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

// Cheap, fast model through the Vercel AI Gateway (authenticated by the
// deployment itself — no API key to manage). Override per environment.
const DIGEST_MODEL = process.env.AI_DIGEST_MODEL ?? "openai/gpt-5-nano";
const DEFAULT_BATCH = 20;
const MAX_BATCH = 40;

// Re-digest a contact only when there has been activity since the last pass.
const staleDigestFilter = sql`coalesce((${contacts.metadata}->'aiDigest'->>'at')::timestamptz, 'epoch'::timestamptz) < ${contacts.lastTouchAt}`;
const notArchivedFilter = sql`(${contacts.metadata}->>'archivedAt') is null`;

export async function POST(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_BATCH)
    : DEFAULT_BATCH;

  const db = getDatabase();

  // Pass 1 — deterministic: fill missing titles from inbound signature blocks.
  // Runs even when no model is reachable.
  let titlesUpdated = 0;
  const untitled = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        isNotNull(contacts.lastTouchAt),
        notArchivedFilter,
        sql`(${contacts.title} is null or ${contacts.title} = '')`,
        eq(contacts.hasManualOverride, false),
      ),
    )
    .orderBy(desc(contacts.lastTouchAt))
    .limit(MAX_BATCH);
  for (const contact of untitled) {
    try {
      const inbound = await db
        .select({ bodyText: messages.bodyText })
        .from(touchpoints)
        .innerJoin(messages, eq(messages.id, touchpoints.messageId))
        .where(
          and(
            eq(touchpoints.contactId, contact.id),
            eq(messages.direction, "inbound"),
            isNotNull(messages.bodyText),
          ),
        )
        .orderBy(desc(messages.sentAt))
        .limit(3);
      const facts = inbound
        .map((row) => extractSignatureFacts(row.bodyText))
        .find(Boolean);
      if (!facts) continue;
      await db
        .update(contacts)
        .set({ title: facts.title })
        .where(
          and(
            eq(contacts.id, contact.id),
            sql`(${contacts.title} is null or ${contacts.title} = '')`,
          ),
        );
      titlesUpdated += 1;
    } catch {
      // Skip quietly; the next pass retries.
    }
  }

  const candidates = await db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      primaryEmail: contacts.primaryEmail,
    })
    .from(contacts)
    .where(and(isNotNull(contacts.lastTouchAt), notArchivedFilter, staleDigestFilter))
    .orderBy(desc(contacts.lastTouchAt))
    .limit(limit);

  let updated = 0;
  let failed = 0;
  for (const contact of candidates) {
    try {
      const recent = await db
        .select({
          direction: touchpoints.direction,
          happenedAt: touchpoints.happenedAt,
          summary: touchpoints.summary,
          metadata: touchpoints.metadata,
        })
        .from(touchpoints)
        .where(
          and(
            eq(touchpoints.contactId, contact.id),
            inArray(touchpoints.kind, ["message", "reply"]),
          ),
        )
        .orderBy(desc(touchpoints.happenedAt))
        .limit(8);
      if (recent.length === 0) continue;

      const prompt = buildDigestPrompt({
        displayName: contact.displayName,
        primaryEmail: contact.primaryEmail,
        messages: recent.map((touchpoint) => {
          const meta = touchpoint.metadata as Record<string, unknown>;
          const subject = [meta.title, meta.subject, meta.label].find(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          );
          return {
            direction: touchpoint.direction,
            at: touchpoint.happenedAt.toISOString(),
            subject: subject ?? null,
            snippet: touchpoint.summary,
          };
        }),
      });

      const { object } = await generateObject({
        model: DIGEST_MODEL,
        schema: conversationDigestSchema,
        prompt,
      });

      const digest = {
        aiDigest: {
          text: object.summary,
          kind: object.kind,
          at: new Date().toISOString(),
          model: DIGEST_MODEL,
        },
      };
      // jsonb concat keeps concurrent metadata writers (archive, sync) intact.
      await db
        .update(contacts)
        .set({
          metadata: sql`${contacts.metadata} || ${JSON.stringify(digest)}::jsonb`,
        })
        .where(eq(contacts.id, contact.id));
      updated += 1;
    } catch {
      // Counts only — never message content or model output in logs.
      failed += 1;
    }
  }

  console.log(
    `[threadline-enrich] scanned=${candidates.length} updated=${updated} failed=${failed} titles=${titlesUpdated} model=${DIGEST_MODEL}`,
  );
  return NextResponse.json({
    ok: failed === 0 || updated > 0 || titlesUpdated > 0,
    scanned: candidates.length,
    updated,
    failed,
    titlesUpdated,
    model: DIGEST_MODEL,
  });
}
