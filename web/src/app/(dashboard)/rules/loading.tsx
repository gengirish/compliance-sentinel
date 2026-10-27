export default function RulesLoading() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <span className="sr-only">Loading rules…</span>
      <div className="h-8 w-48 animate-pulse rounded-lg bg-surface-light" />
      <div className="h-11 w-full max-w-lg animate-pulse rounded-lg bg-surface" />
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="h-11 bg-surface" />
        <div className="divide-y divide-border">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-start gap-6 px-4 py-3.5">
              <div className="flex-1 space-y-2">
                <div className="h-4 w-3/4 max-w-sm animate-pulse rounded bg-surface-light" />
                <div className="h-3 w-24 animate-pulse rounded bg-surface-light" />
              </div>
              <div className="h-5 w-20 animate-pulse rounded-full bg-surface-light" />
              <div className="hidden h-4 w-28 animate-pulse rounded bg-surface-light sm:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
