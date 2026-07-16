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

      <Link
        href="/people"
        className="hidden h-9 w-full max-w-[380px] items-center gap-2 rounded-[7px] border border-line bg-surface-raised px-3 text-left text-[13px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:flex"
        aria-label="Search people and companies"
      >
        <Search className="size-4" strokeWidth={1.8} aria-hidden="true" />
        Search people and companies
      </Link>

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
