"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

import { secondaryButtonClass } from "@/components/people/modal";

export default function OutreachError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="border-y border-line py-16 text-center" role="alert">
      <AlertTriangle
        className="mx-auto size-5 text-danger"
        strokeWidth={1.7}
        aria-hidden="true"
      />
      <h1 className="mt-4 text-[17px] font-semibold text-ink">
        The outreach queue could not be loaded.
      </h1>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-5 text-ink-muted">
        No external action was attempted. Reload the internal planning snapshot
        to continue.
      </p>
      <button
        type="button"
        onClick={reset}
        className={`${secondaryButtonClass} mt-5`}
      >
        <RefreshCw className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}
