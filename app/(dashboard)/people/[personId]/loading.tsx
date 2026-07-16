export default function PersonLoading() {
  return (
    <div
      className="animate-pulse space-y-8"
      aria-label="Loading relationship detail"
    >
      <div className="space-y-4 border-b border-line pb-7">
        <div className="h-4 w-28 rounded bg-surface-subtle" />
        <div className="flex items-center gap-4">
          <div className="size-12 rounded-full bg-surface-subtle" />
          <div className="space-y-2">
            <div className="h-8 w-60 rounded bg-surface-subtle" />
            <div className="h-4 w-80 max-w-full rounded bg-surface-subtle" />
          </div>
        </div>
      </div>
      <div className="grid gap-10 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="space-y-8">
          <div className="h-52 rounded bg-surface-subtle" />
          <div className="h-96 rounded bg-surface-subtle" />
        </div>
        <div className="space-y-6">
          <div className="h-40 rounded bg-surface-subtle" />
          <div className="h-64 rounded bg-surface-subtle" />
        </div>
      </div>
    </div>
  );
}
