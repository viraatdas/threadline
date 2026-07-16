import { z } from "zod";

import { SYNC_CHANNELS } from "@/src/sync/types";

export const unifiedSyncInputSchema = z.object({
  channels: z.array(z.enum(SYNC_CHANNELS)).max(SYNC_CHANNELS.length).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  gmailBackfillDays: z.number().int().min(1).max(3650).optional(),
});

export function normalizeRequestedChannels(
  channels: readonly (typeof SYNC_CHANNELS)[number][] | undefined,
) {
  return channels ? [...new Set(channels)] : undefined;
}
