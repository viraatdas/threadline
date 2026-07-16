import { Link2, Mail, MessageCircle } from "lucide-react";

import type { Channel } from "@/lib/domain/constants";
import { channelLabel } from "@/components/people/formatters";

export function ChannelMark({
  channel,
  showLabel = false,
}: {
  channel: Channel;
  showLabel?: boolean;
}) {
  const Icon =
    channel === "gmail" ? Mail : channel === "linkedin" ? Link2 : MessageCircle;

  return (
    <span
      className="inline-flex min-h-6 items-center gap-1.5 rounded-[6px] border border-line bg-surface-raised px-1.5 text-[11px] text-ink-muted"
      title={channelLabel(channel)}
    >
      <Icon className="size-3" strokeWidth={1.8} aria-hidden="true" />
      {showLabel ? (
        channelLabel(channel)
      ) : (
        <span className="sr-only">{channelLabel(channel)}</span>
      )}
    </span>
  );
}
