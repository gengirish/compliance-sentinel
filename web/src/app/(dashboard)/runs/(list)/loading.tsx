// In the (list) group so it covers /runs only. Wrapping /runs/[id] as well would send a 200 before the
// run page can call notFound().
export default function RunsLoading() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <span className="sr-only">Loading runs…</span>
      <div className="h-8 w-40 animate-pulse rounded-lg bg-surface-light" />
      <div className="h-11 w-full max-w-lg animate-pulse rounded-lg bg-surface" />
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="h-11 bg-surface" />
        <div className="divide-y divide-border">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-6 px-4 py-3.5">
              <div className="h-4 w-16 animate-pulse rounded bg-surface-light" />
              <div className="h-5 w-20 animate-pulse rounded-full bg-surface-light" />
              <div className="hidden h-4 w-32 animate-pulse rounded bg-surface-light sm:block" />
              <div className="ml-auto h-4 w-12 animate-pulse rounded bg-surface-light" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
