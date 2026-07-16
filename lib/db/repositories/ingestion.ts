import { and, eq } from "drizzle-orm";

import type { ThreadlineDatabase } from "@/lib/db/client";
import {
  conversations,
  messages,
  type NewConversation,
  type NewMessage,
  type NewTouchpoint,
  touchpoints,
} from "@/lib/db/schema";

export function createIngestionRepository(database: ThreadlineDatabase) {
  return {
    async findConversation(integrationAccountId: string, externalConversationId: string) {
      const [conversation] = await database
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.integrationAccountId, integrationAccountId),
            eq(conversations.externalConversationId, externalConversationId),
          ),
        )
        .limit(1);

      return conversation ?? null;
    },

    async upsertConversation(input: NewConversation) {
      const [conversation] = await database
        .insert(conversations)
        .values(input)
        .onConflictDoUpdate({
          target: [conversations.integrationAccountId, conversations.externalConversationId],
          set: {
            subject: input.subject,
            preview: input.preview,
            firstMessageAt: input.firstMessageAt,
            lastMessageAt: input.lastMessageAt,
            lastInboundAt: input.lastInboundAt,
            lastOutboundAt: input.lastOutboundAt,
            touchCount: input.touchCount,
            replyState: input.replyState,
            metadata: input.metadata,
            sourceCollectedAt: input.sourceCollectedAt,
            sourceProvenance: input.sourceProvenance,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!conversation) throw new Error("Conversation upsert did not return a row.");
      return conversation;
    },

    insertMessages(input: readonly NewMessage[]) {
      if (input.length === 0) return Promise.resolve([]);
      return database
        .insert(messages)
        .values([...input])
        .onConflictDoNothing({ target: messages.idempotencyKey })
        .returning();
    },

    insertTouchpoints(input: readonly NewTouchpoint[]) {
      if (input.length === 0) return Promise.resolve([]);
      return database
        .insert(touchpoints)
        .values([...input])
        .onConflictDoNothing({ target: touchpoints.idempotencyKey })
        .returning();
    },
  };
}
