import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { hrefWith, type SearchParams } from "@/lib/list-params";

/**
 * "Showing 26–50 of 112" with previous and next links. Renders the count alone on a single page.
 * The count is a polite live region but not `role="status"`, so it never competes with a page's
 * own status message.
 */
export function Pager({
  path,
  params,
  page,
  limit,
  total,
  noun = "results",
  labels = { previous: "Previous", next: "Next" },
}: {
  path: string;
  params: SearchParams;
  page: number;
  limit: number;
  total: number;
  noun?: string;
  /** Visible link text, such as "Newer" and "Older" for a list sorted newest first. */
  labels?: { previous: string; next: string };
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  const box = "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg border border-border px-3";
  const link = (target: number, enabled: boolean, content: React.ReactNode) =>
    enabled ? (
      <Link href={hrefWith(path, params, { page: target })} prefetch={false} className={`${box} text-muted hover:text-foreground`}>
        {content}
      </Link>
    ) : (
      <span aria-disabled className={`${box} opacity-40`}>
        {content}
      </span>
    );

  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-muted">
      <p aria-live="polite">
        {total === 0
          ? `No ${noun}`
          : from > total
            ? `Page ${page} is past the end: there are ${total} ${noun}`
            : `Showing ${from}–${to} of ${total} ${noun}`}
      </p>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          {link(
            Math.min(page - 1, pages),
            page > 1,
            <>
              <ChevronLeft className="size-4" aria-hidden />
              {labels.previous}
            </>,
          )}
          <span className="tabular-nums">
            <span className="sr-only">Page </span>
            {page}
            <span aria-hidden> / </span>
            <span className="sr-only"> of </span>
            {pages}
          </span>
          {link(
            page + 1,
            page < pages,
            <>
              {labels.next}
              <ChevronRight className="size-4" aria-hidden />
            </>,
          )}
        </div>
      )}
    </nav>
  );
}
