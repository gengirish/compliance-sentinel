import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-border bg-surface p-5", className)} {...props} />;
}

/**
 * Renders a <p> by default: most cards are stat tiles whose label is not a section heading.
 * Pass `as="h2"` (or h3) when the card really opens a section.
 */
export function CardTitle({
  as: Tag = "p",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: "p" | "h2" | "h3" }) {
  return <Tag className={cn("text-sm font-semibold uppercase tracking-wide text-muted", className)} {...props} />;
}
