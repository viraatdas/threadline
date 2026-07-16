import Link from "next/link";
import { ArrowRight, Inbox, PlugZap } from "lucide-react";

import { PageHeader } from "@/components/shell";

export function DashboardEmpty() {
  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Private workspace"
        title="Build your relationship memory"
        description="Threadline is ready to observe read-only outreach history. Connect a source to identify customer conversations, replies, and follow-ups without changing anything outside this workspace."
      />

      <section
        aria-labelledby="empty-start-heading"
        className="border-y border-line py-10 sm:py-14"
      >
        <div className="mx-auto max-w-xl text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-[8px] bg-accent-subtle text-accent-strong">
            <Inbox className="size-5" strokeWidth={1.7} aria-hidden="true" />
          </span>
          <h2
            id="empty-start-heading"
            className="mt-5 text-[17px] font-semibold tracking-[-0.02em] text-ink"
          >
            No relationship threads yet
          </h2>
          <p className="mt-2 text-[13px] leading-6 text-ink-muted">
            Start with Gmail, LinkedIn, or X. The first read-only sync will
            preserve source evidence, connect people to companies, and surface
            only the few threads that need attention.
          </p>
          <div className="mt-6 flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center">
            <Link
              href="/settings"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[6px] bg-accent-strong px-4 text-[12px] font-semibold text-white transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
            >
              <PlugZap
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              Connect a source
            </Link>
            <Link
              href="/?demo=1"
              className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[6px] border border-line px-4 text-[12px] font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
            >
              Preview with demo data
              <ArrowRight
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="empty-expect-heading">
        <div className="mb-4">
          <h2
            id="empty-expect-heading"
            className="text-[15px] font-semibold text-ink"
          >
            What appears after sync
          </h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            A focused daily view, not a pipeline dashboard.
          </p>
        </div>
        <dl className="grid border-y border-line sm:grid-cols-3">
          {[
            [
              "Next actions",
              "Planned outreach and follow-ups ordered by urgency and evidence.",
            ],
            [
              "Reply memory",
              "Last contact, touch count, reply state, and recent conversation context.",
            ],
            [
              "Source health",
              "Freshness for each connector plus transparent analysis queue status.",
            ],
          ].map(([title, description], index) => (
            <div
              key={title}
              className={`py-5 sm:px-5 ${index > 0 ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}
            >
              <dt className="text-[12px] font-semibold text-ink">{title}</dt>
              <dd className="mt-1.5 text-[12px] leading-5 text-ink-muted">
                {description}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
