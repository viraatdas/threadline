export function DashboardLoading() {
  return (
    <div
      className="space-y-10"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading relationship overview.</span>
      <div className="border-b border-line pb-7">
        <div className="h-3 w-36 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
        <div className="mt-3 h-8 w-72 max-w-full animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
        <div className="mt-3 h-4 w-[620px] max-w-full animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
      </div>
      <section aria-hidden="true">
        <div className="h-5 w-28 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
        <div className="mt-4 border-y border-line">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="border-b border-line py-5 last:border-b-0"
            >
              <div className="h-3 w-32 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
              <div className="mt-3 h-5 w-56 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
              <div className="mt-3 h-3 w-4/5 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      </section>
      <div
        className="grid border-y border-line sm:grid-cols-3 xl:grid-cols-6"
        aria-hidden="true"
      >
        {[0, 1, 2, 3, 4, 5].map((metric) => (
          <div
            key={metric}
            className="border-b border-line py-4 sm:border-r sm:px-4 xl:border-b-0"
          >
            <div className="h-3 w-20 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
            <div className="mt-3 h-7 w-12 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}
