import {
  CircleCheck,
  CircleDashed,
  Clock3,
  MessageCircleReply,
  Sparkles,
  UserRoundPen,
} from "lucide-react";

import type { ReplyState } from "@/lib/domain/constants";
import type { EvidenceKind } from "@/components/people/types";
import { replyLabel } from "@/components/people/formatters";

const badgeBase =
  "inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap";

export function ReplyBadge({ state }: { state: ReplyState }) {
  const Icon =
    state === "replied"
      ? MessageCircleReply
      : state === "awaiting_reply"
        ? Clock3
        : CircleDashed;
  const treatment =
    state === "replied"
      ? "border-accent/25 bg-accent-subtle text-accent-strong"
      : state === "awaiting_reply"
        ? "border-warning/30 bg-warning/8 text-ink"
        : "border-line bg-surface-raised text-ink-muted";

  return (
    <span className={`${badgeBase} ${treatment}`}>
      <Icon className="size-3" strokeWidth={1.8} aria-hidden="true" />
      {replyLabel(state)}
    </span>
  );
}

export function EvidenceBadge({ kind }: { kind: EvidenceKind }) {
  const Icon =
    kind === "observed"
      ? CircleCheck
      : kind === "inferred"
        ? Sparkles
        : UserRoundPen;
  const label =
    kind === "observed"
      ? "Observed fact"
      : kind === "inferred"
        ? "Model inference"
        : "User override";
  const treatment =
    kind === "observed"
      ? "border-secondary/25 bg-secondary/8 text-secondary"
      : kind === "inferred"
        ? "border-line bg-surface-raised text-ink-muted"
        : "border-accent/25 bg-accent-subtle text-accent-strong";

  return (
    <span className={`${badgeBase} ${treatment}`}>
      <Icon className="size-3" strokeWidth={1.8} aria-hidden="true" />
      {label}
    </span>
  );
}
