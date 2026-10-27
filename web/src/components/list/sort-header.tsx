import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { hrefWith, type SearchParams, type SortOrder, type SortState } from "@/lib/list-params";
import { cn } from "@/lib/utils";

type Props<K extends string> = {
  path: string;
  params: SearchParams;
  current: SortState<K>;
  sortKey: K;
  /** Direction a first click sorts in: newest, largest or worst first is usually "desc". */
  firstOrder?: SortOrder;
  align?: "left" | "right";
  children: React.ReactNode;
};

/**
 * A table header that sorts by its column. The first click sorts in `firstOrder`, the next
 * reverses it. `aria-sort` tells screen readers which column the table is sorted by.
 */
export function SortHeader<K extends string>({ path, params, current, sortKey, firstOrder = "desc", align = "left", children }: Props<K>) {
  const active = current.sort === sortKey;
  const nextOrder: SortOrder = active ? (current.order === "asc" ? "desc" : "asc") : firstOrder;
  const Icon = !active ? ArrowUpDown : current.order === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (current.order === "asc" ? "ascending" : "descending") : "none"}
      className={cn("px-4 py-3 font-semibold", align === "right" && "text-right")}
    >
      <Link
        href={hrefWith(path, params, { sort: sortKey, order: nextOrder })}
        prefetch={false}
        scroll={false}
        className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground", align === "right" && "flex-row-reverse")}
      >
        {children}
        <Icon className={cn("size-3.5", !active && "opacity-40")} aria-hidden />
      </Link>
    </th>
  );
}
