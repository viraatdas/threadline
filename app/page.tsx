import { ArrowUpRight, CalendarClock, CircleCheck, Mail, MessagesSquare } from "lucide-react";

import { PageHeader } from "@/components/shell";

const sourceRows = [
  {
    source: "Gmail",
    description: "Customer outreach threads and reply history",
  },
  {
    source: "LinkedIn",
    description: "Direct-message conversations through a read-only MCP connector",
  },
  {
    source: "X",
    description: "Direct-message and profile context through Bird read operations",
  },
] as const;

const pulseRows = [
  { label: "Planned", value: "0", icon: CalendarClock },
  { label: "Reached out", value: "0", icon: Mail },
  { label: "Awaiting reply", value: "0", icon: MessagesSquare },
  { label: "Replied", value: "0", icon: CircleCheck },
] as const;

export default function OverviewPage() {
  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Private workspace"
        title="Your relationship threads, kept in context."
        description="Threadline brings outreach, replies, roles, and follow-up plans into one source-grounded view. Nothing is sent or changed outside this workspace."
      />

      <section aria-labelledby="pulse-heading">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <div>
            <h2 id="pulse-heading" className="text-[15px] font-semibold text-ink">
              Relationship pulse
            </h2>
            <p className="mt-1 text-[13px] text-ink-muted">A quiet summary of what needs judgment.</p>
          </div>
          <span className="text-[12px] text-ink-faint">No sources synced yet</span>
        </div>

        <dl className="grid border-y border-line sm:grid-cols-2 lg:grid-cols-4">
          {pulseRows.map(({ label, value, icon: Icon }, index) => (
            <div
              key={String(label)}
              className={`py-5 sm:px-5 ${index === 0 ? "sm:pl-0" : ""} ${index > 0 ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}
            >
              <dt className="flex items-center gap-2 text-[12px] font-medium text-ink-muted">
                <Icon className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                {label}
              </dt>
              <dd className="mt-2 text-[24px] font-semibold tracking-[-0.03em] text-ink tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)] xl:gap-14">
        <section aria-labelledby="attention-heading">
          <div className="mb-4">
            <h2 id="attention-heading" className="text-[15px] font-semibold text-ink">
              Attention queue
            </h2>
            <p className="mt-1 text-[13px] text-ink-muted">
              Follow-ups, unanswered outreach, and uncertain classifications will collect here.
            </p>
          </div>

          <div className="border-y border-line py-12 text-center">
            <MessagesSquare
              className="mx-auto size-5 text-ink-faint"
              strokeWidth={1.6}
              aria-hidden="true"
            />
            <p className="mt-4 text-[14px] font-medium text-ink">Nothing needs your attention yet.</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] leading-5 text-ink-muted">
              Once a source has synced, Threadline will surface only the relationships that need a
              decision or follow-up.
            </p>
          </div>
        </section>

        <section aria-labelledby="sources-heading">
          <div className="mb-4">
            <h2 id="sources-heading" className="text-[15px] font-semibold text-ink">
              Read-only sources
            </h2>
            <p className="mt-1 text-[13px] text-ink-muted">
              Configure credentials in Settings when connector features land.
            </p>
          </div>

          <div className="border-y border-line">
            {sourceRows.map((row) => (
              <div
                key={row.source}
                className="group flex items-start gap-4 border-b border-line py-4 last:border-b-0"
              >
                <span className="mt-1 size-2 shrink-0 rounded-full bg-line-strong" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[13px] font-medium text-ink">{row.source}</p>
                    <span className="text-[11px] text-ink-faint">Not configured</span>
                  </div>
                  <p className="mt-1 text-[12px] leading-5 text-ink-muted">{row.description}</p>
                </div>
              </div>
            ))}
          </div>

          <a
            href="/settings"
            className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent-strong hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            Review source settings
            <ArrowUpRight className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
          </a>
        </section>
      </div>
    </div>
  );
}
