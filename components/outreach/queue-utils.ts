import type {
  OutreachPlanView,
  OutreachQueueGroup,
} from "@/components/people/types";

const dayMs = 24 * 60 * 60 * 1000;

export function outreachQueueGroup(
  plan: OutreachPlanView,
  now: string,
): OutreachQueueGroup | null {
  if (plan.status === "completed" || plan.status === "cancelled") return null;
  if (plan.replyState === "replied") return "replied";
  if (
    plan.status === "planned" &&
    plan.nextTouchAt &&
    new Date(plan.nextTouchAt) > new Date(now)
  ) {
    return "planned";
  }

  if (plan.replyState === "awaiting_reply" && plan.lastTouchAt) {
    const ageDays =
      (new Date(now).getTime() - new Date(plan.lastTouchAt).getTime()) / dayMs;
    if (ageDays >= 14) return "stale";
  }

  if (plan.nextTouchAt && new Date(plan.nextTouchAt) <= new Date(now))
    return "due";
  if (plan.replyState === "awaiting_reply") return "waiting";
  return "planned";
}

export function groupOutreachPlans(plans: OutreachPlanView[], now: string) {
  const groups: Record<OutreachQueueGroup, OutreachPlanView[]> = {
    planned: [],
    due: [],
    waiting: [],
    replied: [],
    stale: [],
  };

  for (const plan of plans) {
    const group = outreachQueueGroup(plan, now);
    if (group) groups[group].push(plan);
  }

  for (const group of Object.values(groups)) {
    group.sort((left, right) => {
      const leftDate = left.nextTouchAt ?? left.lastTouchAt ?? left.createdAt;
      const rightDate =
        right.nextTouchAt ?? right.lastTouchAt ?? right.createdAt;
      return new Date(leftDate).getTime() - new Date(rightDate).getTime();
    });
  }

  return groups;
}
