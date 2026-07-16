import { and, asc, eq, isNotNull, lte, or } from "drizzle-orm";

import type { ThreadlineDatabase } from "@/lib/db/client";
import {
  channelIdentities,
  contacts,
  outreachPlans,
  type NewContact,
  type NewOutreachPlan,
} from "@/lib/db/schema";

export function createContactRepository(database: ThreadlineDatabase) {
  return {
    async findById(id: string) {
      const [contact] = await database.select().from(contacts).where(eq(contacts.id, id)).limit(1);
      return contact ?? null;
    },

    async findByChannelIdentity(channel: "gmail" | "linkedin" | "x", externalId: string) {
      const [contact] = await database
        .select({ contact: contacts })
        .from(channelIdentities)
        .innerJoin(contacts, eq(channelIdentities.contactId, contacts.id))
        .where(
          and(eq(channelIdentities.channel, channel), eq(channelIdentities.externalId, externalId)),
        )
        .limit(1);

      return contact?.contact ?? null;
    },

    async create(input: NewContact) {
      const [contact] = await database.insert(contacts).values(input).returning();
      if (!contact) throw new Error("Contact insert did not return a row.");
      return contact;
    },

    listNeedingAttention(now = new Date(), limit = 50) {
      return database
        .select()
        .from(contacts)
        .where(
          or(
            and(isNotNull(contacts.plannedFollowUpAt), lte(contacts.plannedFollowUpAt, now)),
            eq(contacts.replyState, "awaiting_reply"),
          ),
        )
        .orderBy(asc(contacts.plannedFollowUpAt), asc(contacts.lastTouchAt))
        .limit(limit);
    },

    async createPlan(input: NewOutreachPlan) {
      const [plan] = await database.insert(outreachPlans).values(input).returning();
      if (!plan) throw new Error("Outreach plan insert did not return a row.");
      return plan;
    },
  };
}
