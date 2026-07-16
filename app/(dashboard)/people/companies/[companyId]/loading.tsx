export default function CompanyLoading() {
  return (
    <div
      className="animate-pulse space-y-8"
      aria-label="Loading company detail"
    >
      <div className="space-y-4 border-b border-line pb-7">
        <div className="h-4 w-28 rounded bg-surface-subtle" />
        <div className="flex items-center gap-4">
          <div className="size-12 rounded-[10px] bg-surface-subtle" />
          <div className="space-y-2">
            <div className="h-8 w-64 rounded bg-surface-subtle" />
            <div className="h-4 w-72 max-w-full rounded bg-surface-subtle" />
          </div>
        </div>
      </div>
      <div className="grid gap-10 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="h-96 rounded bg-surface-subtle" />
        <div className="h-72 rounded bg-surface-subtle" />
      </div>
    </div>
  );
}
