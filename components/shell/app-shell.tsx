import type { ReactNode } from "react";

import { MobileNav } from "@/components/shell/mobile-nav";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";

interface AppShellProps {
  children: ReactNode;
  ownerEmail: string;
  ownerName?: string | null | undefined;
}

export function AppShell({ children, ownerEmail, ownerName }: AppShellProps) {
  return (
    <div className="flex min-h-screen bg-background text-ink">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar ownerEmail={ownerEmail} ownerName={ownerName} />
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-7 pb-24 sm:px-6 sm:py-9 lg:px-10 lg:pb-10">
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
