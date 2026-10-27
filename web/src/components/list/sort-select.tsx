"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import type { SortOrder } from "@/lib/list-params";
import { useSetParam } from "./url-controls";

type Option<K extends string> = {
  value: K;
  label: string;
  /** Direction picking this key sorts in: worst first is usually "desc", names "asc". */
  firstOrder: SortOrder;
};

const fieldClass =
  "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-accent";

/**
 * Sort for a list that is not a table (where `SortHeader` does the job): a select of keys and a
 * button that reverses the order. The default sort is left out of the URL.
 */
export function SortSelect<K extends string>({
  label = "Sort by",
  options,
  defaults,
}: {
  label?: string;
  options: Option<K>[];
  defaults: { sort: K; order: SortOrder };
}) {
  const { set, searchParams } = useSetParam();
  const sort = options.find((o) => o.value === searchParams.get("sort"))?.value ?? defaults.sort;
  const rawOrder = searchParams.get("order");
  const order: SortOrder = rawOrder === "asc" || rawOrder === "desc" ? rawOrder : defaults.order;

  const write = (nextSort: K, nextOrder: SortOrder) =>
    set(nextSort === defaults.sort && nextOrder === defaults.order ? { sort: null, order: null } : { sort: nextSort, order: nextOrder });
  const Icon = order === "asc" ? ArrowUp : ArrowDown;

  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <label className="flex items-center gap-2">
        {label}
        <select
          value={sort}
          onChange={(e) => {
            const next = options.find((o) => o.value === e.target.value)!;
            write(next.value, next.firstOrder);
          }}
          className={fieldClass}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => write(sort, order === "asc" ? "desc" : "asc")}
        aria-label={order === "asc" ? "Ascending; switch to descending" : "Descending; switch to ascending"}
        title="Reverse order"
        className="inline-flex items-center rounded-lg border border-border p-1.5 text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Icon className="size-4" aria-hidden />
      </button>
    </div>
  );
}
