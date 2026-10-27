import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { hrefWith, type SearchParams } from "@/lib/list-params";
import { cn } from "@/lib/utils";

/** "Showing 26–50 of 112" with previous and next links. Renders the count alone on a single page. */
export function Pager({
  path,
  params,
  page,
  limit,
  total,
  noun = "results",
}: {
  path: string;
  params: SearchParams;
  page: number;
  limit: number;
  total: number;
  noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  const link = (target: number, enabled: boolean, label: string, icon: React.ReactNode) =>
    enabled ? (
      <Link
        href={hrefWith(path, params, { page: target })}
        prefetch={false}
        aria-label={label}
        className="inline-flex items-center rounded-lg border border-border px-2 py-1 text-muted hover:text-foreground"
      >
        {icon}
      </Link>
    ) : (
      <span aria-hidden className="inline-flex items-center rounded-lg border border-border px-2 py-1 opacity-40">
        {icon}
      </span>
    );

  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-4 text-sm text-muted">
      {/* aria-live without role="status": a page can have one status already, such as the run audit button's. */}
      <p aria-live="polite">
        {total === 0 ? `No ${noun}` : `Showing ${from}–${to} of ${total} ${noun}`}
      </p>
      {pages > 1 && (
        <div className={cn("flex items-center gap-2")}>
          {link(page - 1, page > 1, "Previous page", <ChevronLeft className="size-4" aria-hidden />)}
          <span className="tabular-nums">
            {page} / {pages}
          </span>
          {link(page + 1, page < pages, "Next page", <ChevronRight className="size-4" aria-hidden />)}
        </div>
      )}
    </nav>
  );
}
