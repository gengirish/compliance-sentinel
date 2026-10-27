import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A toggle that is a link: clicking it rewrites the URL and the server re-renders the list.
 * No prefetch: a toolbar of chips would otherwise cost a server render each (DEF-004).
 */
export function FilterChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
      className={cn(
        // min-h-11: a 44px touch target.
        "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm",
        active ? "border-primary-light/50 bg-primary/20 text-foreground" : "border-border text-muted hover:text-foreground",
      )}
    >
      {children}
      {/* A link cannot be aria-pressed, and aria-current means "this page", so the on state is spoken as text. */}
      {active && <span className="sr-only"> (filter on)</span>}
    </Link>
  );
}

/** A labelled row of chips. */
export function FilterChips({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function ChipDivider() {
  return <span className="mx-1 h-5 w-px bg-border" aria-hidden />;
}
