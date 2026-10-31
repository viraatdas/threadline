import Link from "next/link";
import { LogOut, Search } from "lucide-react";

import { BrandMark } from "@/components/shell/brand-mark";

interface TopbarProps {
  ownerEmail: string;
  ownerName?: string | null | undefined;
}

function ownerInitial(name: string | null | undefined, email: string) {
  return (name?.trim().at(0) ?? email.at(0) ?? "T").toUpperCase();
}

export function Topbar({ ownerEmail, ownerName }: TopbarProps) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-line bg-background px-4 sm:px-6 lg:px-8">
      <div className="lg:hidden">
        <BrandMark />
      </div>

      <form action="/prospects" className="hidden w-full max-w-[380px] lg:block" role="search">
        <label className="flex h-9 items-center gap-2 rounded-[7px] border border-line bg-surface-raised px-3 text-[13px] text-ink-muted focus-within:border-line-strong">
          <Search className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
          <span className="sr-only">Search prospects</span>
          <input
            name="q"
            placeholder="Search companies"
            className="h-full w-full bg-transparent text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
      </form>

      <div className="flex items-center gap-2.5">
        <div className="hidden text-right sm:block">
          <p className="max-w-48 truncate text-[12px] font-medium text-ink">
            {ownerName?.trim() || "Owner"}
          </p>
          <p className="max-w-48 truncate text-[11px] text-ink-faint">{ownerEmail}</p>
        </div>
        <span
          className="grid size-8 place-items-center rounded-full bg-ink text-[12px] font-semibold text-white"
          aria-hidden="true"
        >
          {ownerInitial(ownerName, ownerEmail)}
        </span>
        <Link
          href="/api/auth/signout"
          aria-label="Sign out"
          className="grid size-8 place-items-center rounded-[7px] text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <LogOut className="size-4" strokeWidth={1.8} aria-hidden="true" />
        </Link>
      </div>
    </header>
  );
}
