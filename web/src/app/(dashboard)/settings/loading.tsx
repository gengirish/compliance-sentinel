export default function SettingsLoading() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <span className="sr-only">Loading settings…</span>
      <div className="h-8 w-56 animate-pulse rounded-lg bg-surface-light" />
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex-1 space-y-2">
              <div className="h-4 w-48 animate-pulse rounded bg-surface-light" />
              <div className="h-3 w-full max-w-md animate-pulse rounded bg-surface-light" />
              <div className="h-3 w-32 animate-pulse rounded bg-surface-light" />
            </div>
            <div className="h-11 w-28 animate-pulse rounded-lg bg-surface" />
          </div>
        ))}
      </div>
    </div>
  );
}
