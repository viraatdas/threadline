import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@/app/globals.css";

import { AppShell } from "@/components/shell";
import { requireOwner } from "@/lib/auth";

export const metadata: Metadata = {
  title: {
    default: "Outbound",
    template: "%s · Outbound",
  },
  description: "Find teams that need Macs, research them, and run email + LinkedIn sequences you approve.",
  robots: {
    index: false,
    follow: false,
  },
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await requireOwner();
  const ownerEmail = session.user?.email;

  if (!ownerEmail) {
    throw new Error("Owner session is missing an email address.");
  }

  return (
    <html lang="en">
      <body>
        <AppShell ownerEmail={ownerEmail} ownerName={session.user?.name}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
