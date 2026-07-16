import Link from "next/link";
import {
  Building2,
  CalendarClock,
  ContactRound,
  Inbox,
  Settings2,
  Waypoints,
} from "lucide-react";

import { BrandMark } from "@/components/shell/brand-mark";

const navigation = [
  { label: "Overview", href: "/", icon: Waypoints, active: true },
  { label: "Attention", href: "/attention", icon: Inbox, active: false },
  { label: "People", href: "/people", icon: ContactRound, active: false },
  { label: "Companies", href: "/companies", icon: Building2, active: false },
  { label: "Plans", href: "/plans", icon: CalendarClock, active: false },
] as const;

export function Sidebar() {
  return (
    <aside className="hidden min-h-screen w-[232px] shrink-0 border-r border-line bg-surface-subtle px-3 py-4 lg:flex lg:flex-col">
      <div className="px-2 pb-7">
        <BrandMark />
      </div>

      <nav aria-label="Primary navigation" className="space-y-0.5">
        {navigation.map(({ label, href, icon: Icon, active }) => (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "relative flex h-9 items-center gap-3 rounded-[7px] bg-white px-3 text-[13px] font-medium text-ink shadow-[inset_0_0_0_1px_var(--line)] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r before:bg-accent"
                : "flex h-9 items-center gap-3 rounded-[7px] px-3 text-[13px] font-medium text-ink-muted transition-colors hover:bg-white/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            }
          >
            <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-auto border-t border-line pt-3">
        <Link
          href="/settings"
          className="flex h-9 items-center gap-3 rounded-[7px] px-3 text-[13px] font-medium text-ink-muted transition-colors hover:bg-white/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Settings2 className="size-4" strokeWidth={1.8} aria-hidden="true" />
          Settings
        </Link>
      </div>
    </aside>
  );
}
