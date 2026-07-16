import { format, formatDistanceStrict } from "date-fns";

import type { ActionKind } from "@/components/dashboard/types";

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
}

export function formatRelativeTime(value: string, nowValue: string) {
  return formatDistanceStrict(new Date(value), new Date(nowValue), {
    addSuffix: true,
  });
}

export function formatDueDate(value: string | null, nowValue: string) {
  if (!value) return "No date";

  const date = new Date(value);
  const now = new Date(nowValue);
  const dayStart = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const nowStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const dayDifference = Math.round((dayStart - nowStart) / 86_400_000);

  if (dayDifference === -1) return "Yesterday";
  if (dayDifference === 0) return "Today";
  if (dayDifference === 1) return "Tomorrow";

  return format(
    date,
    date.getFullYear() === now.getFullYear() ? "MMM d" : "MMM d, yyyy",
  );
}

export function formatDashboardDate(value: string) {
  return format(new Date(value), "EEEE, MMMM d");
}

export function actionKindLabel(kind: ActionKind) {
  if (kind === "planned_outreach") return "Planned outreach";
  if (kind === "follow_up") return "Follow-up";
  return "Awaiting reply";
}

export function replyStateLabel(replyState: string) {
  if (replyState === "replied") return "Replied";
  if (replyState === "awaiting_reply") return "Awaiting reply";
  if (replyState === "not_applicable") return "No reply expected";
  return "Reply unknown";
}
