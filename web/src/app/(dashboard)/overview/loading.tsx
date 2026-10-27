// Lives under overview/ rather than the dashboard group, where it would wrap every page: a loading.tsx
// above /runs/[id] starts the response before the run lookup, so a missing run got a 200, not a 404.
// role="status" plus the sr-only text is what screen readers announce; an aria-label on a plain div is not.
export default function Loading() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="h-8 w-56 animate-pulse rounded-lg bg-surface-light" />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-surface" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-surface" />
    </div>
  );
}
