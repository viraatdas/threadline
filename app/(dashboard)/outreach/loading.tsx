export default function OutreachLoading() {
  return (
    <div
      className="animate-pulse space-y-8"
      aria-label="Loading outreach queue"
    >
      <div className="space-y-3 border-b border-line pb-7">
        <div className="h-3 w-28 rounded bg-surface-subtle" />
        <div className="h-8 w-56 rounded bg-surface-subtle" />
        <div className="h-4 w-[560px] max-w-full rounded bg-surface-subtle" />
      </div>
      <div className="grid border-y border-line sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="h-20 border-line bg-surface-subtle/50 sm:border-l"
          />
        ))}
      </div>
      <div className="space-y-8">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index}>
            <div className="mb-3 h-5 w-36 rounded bg-surface-subtle" />
            <div className="h-52 rounded bg-surface-subtle" />
          </div>
        ))}
      </div>
    </div>
  );
}
