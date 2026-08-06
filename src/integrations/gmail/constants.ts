import type { ReadOnlyCapabilities } from "@/lib/domain/schemas";

export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SCOPES = [GMAIL_READONLY_SCOPE] as const;
export const GMAIL_CURSOR_RESOURCE = "gmail-history";
export const GMAIL_DEFAULT_BACKFILL_DAYS = 120;
export const GMAIL_MIN_BACKFILL_DAYS = 1;
export const GMAIL_MAX_BACKFILL_DAYS = 3650;
// How far back the scheduled forced backfill walks. ~1.5 years is where
// relationships stop being actionable; deeper history only costs quota,
// egress, and function time. Keep `vercel.json`'s cron path in step.
export const GMAIL_BACKFILL_TARGET_DAYS = 548;
export const GMAIL_OAUTH_STATE_COOKIE = "threadline.gmail.oauth-state";
export const GMAIL_OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export const GMAIL_READ_ONLY_CAPABILITIES: ReadOnlyCapabilities = {
  read: true,
  draft: false,
  send: false,
  modify: false,
  delete: false,
  connect: false,
  post: false,
  reply: false,
};

export function clampBackfillDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value))
    return GMAIL_DEFAULT_BACKFILL_DAYS;
  return Math.min(
    GMAIL_MAX_BACKFILL_DAYS,
    Math.max(GMAIL_MIN_BACKFILL_DAYS, Math.floor(value)),
  );
}
