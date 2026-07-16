export default function PeopleLoading() {
  return (
    <div
      className="animate-pulse space-y-8"
      aria-label="Loading people workspace"
    >
      <div className="space-y-3 border-b border-line pb-7">
        <div className="h-3 w-28 rounded bg-surface-subtle" />
        <div className="h-8 w-64 max-w-full rounded bg-surface-subtle" />
        <div className="h-4 w-[520px] max-w-full rounded bg-surface-subtle" />
      </div>
      <div className="flex gap-3">
        <div className="h-9 w-52 rounded bg-surface-subtle" />
        <div className="h-9 flex-1 rounded bg-surface-subtle" />
      </div>
      <div className="border-y border-line">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="grid grid-cols-[40px_1fr_160px] gap-4 border-b border-line py-4 last:border-b-0"
          >
            <div className="size-9 rounded-full bg-surface-subtle" />
            <div className="space-y-2">
              <div className="h-3 w-40 rounded bg-surface-subtle" />
              <div className="h-3 w-64 max-w-full rounded bg-surface-subtle" />
            </div>
            <div className="h-7 rounded bg-surface-subtle" />
          </div>
        ))}
      </div>
    </div>
  );
}
