import Link from "next/link";
import { ArrowRight, CircleAlert, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/shell";

interface DashboardErrorProps {
  message: string;
}

export function DashboardError({ message }: DashboardErrorProps) {
  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Overview unavailable"
        title="The relationship view could not load"
        description="No source data was changed. Try the read again, or preview the complete workflow with isolated demo records."
      />

      <section
        aria-labelledby="dashboard-error-heading"
        role="alert"
        className="border-y border-line py-10 sm:py-12"
      >
        <div className="mx-auto max-w-xl">
          <div className="flex items-start gap-3">
            <CircleAlert
              className="mt-0.5 size-5 shrink-0 text-danger"
              strokeWidth={1.7}
              aria-hidden="true"
            />
            <div>
              <h2
                id="dashboard-error-heading"
                className="text-[14px] font-semibold text-ink"
              >
                Dashboard data is temporarily unavailable
              </h2>
              <p className="mt-1.5 text-[12px] leading-5 text-ink-muted">
                {message}
              </p>
            </div>
          </div>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            <Link
              href="/"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[6px] bg-accent-strong px-4 text-[12px] font-semibold text-white transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
            >
              <RefreshCw
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              Try again
            </Link>
            <Link
              href="/?demo=1"
              className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[6px] border border-line px-4 text-[12px] font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
            >
              Open demo view
              <ArrowRight
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
