import { Building2, Inbox, Radar, Send, Settings2, Users } from "lucide-react";

export const navigation = [
  { label: "Today", href: "/", icon: Inbox },
  { label: "Find", href: "/find", icon: Radar },
  { label: "Prospects", href: "/prospects", icon: Building2 },
  { label: "People", href: "/people", icon: Users },
  { label: "Campaigns", href: "/campaigns", icon: Send },
  { label: "Settings", href: "/settings", icon: Settings2 },
] as const;

export const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname.startsWith(href);
