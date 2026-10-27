import Link from "next/link";

/** Back to the unfiltered list. Render it only when a filter is set (see `hasAny`). */
export function ClearFilters({ href }: { href: string }) {
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
      className="inline-flex min-h-11 items-center px-2 text-sm text-muted hover:text-foreground"
    >
      Clear
    </Link>
  );
}
