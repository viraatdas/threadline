import { Building2, Inbox, Radar, Send, Settings2 } from "lucide-react";

export const navigation = [
  { label: "Today", href: "/", icon: Inbox },
  { label: "Find", href: "/find", icon: Radar },
  { label: "Prospects", href: "/prospects", icon: Building2 },
  { label: "Campaigns", href: "/campaigns", icon: Send },
  { label: "Settings", href: "/settings", icon: Settings2 },
] as const;

export const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname.startsWith(href);
