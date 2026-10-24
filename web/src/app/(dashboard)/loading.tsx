export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-surface-light" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-surface" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-surface" />
    </div>
  );
}
