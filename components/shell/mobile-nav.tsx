"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isActive, navigation } from "@/components/shell/nav";

export function MobileNav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-6 border-t border-line bg-white/95 px-2 pt-2 pb-[max(8px,env(safe-area-inset-bottom))] backdrop-blur lg:hidden"
    >
      {navigation.map(({ label, href, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "flex min-h-11 flex-col items-center justify-center gap-1 rounded-[7px] text-[10px] font-medium text-accent-strong"
                : "flex min-h-11 flex-col items-center justify-center gap-1 rounded-[7px] text-[10px] font-medium text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            }
          >
            <Icon className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
