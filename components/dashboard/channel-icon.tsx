import { AtSign, ContactRound, Mail } from "lucide-react";

import type { Channel } from "@/lib/domain/constants";

interface ChannelIconProps {
  channel: Channel;
  className?: string;
}

export const channelLabels: Record<Channel, string> = {
  gmail: "Gmail",
  linkedin: "LinkedIn",
  x: "X",
};

export function ChannelIcon({
  channel,
  className = "size-3.5",
}: ChannelIconProps) {
  if (channel === "gmail") {
    return <Mail className={className} strokeWidth={1.8} aria-hidden="true" />;
  }

  if (channel === "linkedin") {
    return (
      <ContactRound
        className={className}
        strokeWidth={1.8}
        aria-hidden="true"
      />
    );
  }

  return <AtSign className={className} strokeWidth={1.8} aria-hidden="true" />;
}
