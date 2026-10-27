export default function RunLoading() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading run…</span>
      <div className="mb-4 h-4 w-20 animate-pulse rounded bg-surface-light" />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-8 w-40 animate-pulse rounded-lg bg-surface-light" />
          <div className="h-4 w-64 animate-pulse rounded bg-surface-light" />
        </div>
        <div className="h-11 w-36 animate-pulse rounded-lg bg-surface" />
      </div>
      <div className="mb-6 flex flex-wrap gap-2">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="h-8 w-24 animate-pulse rounded-full bg-surface" />
        ))}
      </div>
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-border bg-surface p-5">
            <div className="flex gap-2">
              <div className="h-5 w-20 animate-pulse rounded-full bg-surface-light" />
              <div className="h-5 w-16 animate-pulse rounded-full bg-surface-light" />
            </div>
            <div className="h-5 w-2/3 animate-pulse rounded bg-surface-light" />
            <div className="h-3 w-full animate-pulse rounded bg-surface-light" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-surface-light" />
          </div>
        ))}
      </div>
    </div>
  );
}
