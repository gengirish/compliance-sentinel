"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Client controls that write one URL parameter each. The server page re-renders from the new
 * URL, so these hold no list state of their own. Changing a filter returns to page 1.
 */
function useSetParam() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const set = (changes: Record<string, string | null>, mode: "push" | "replace" = "push") => {
    const q = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") q.delete(k);
      else q.set(k, v);
    }
    q.delete("page");
    const qs = q.toString();
    startTransition(() => router[mode](qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };
  return { set, pending, searchParams };
}

const fieldClass =
  "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-accent";

/** Free-text search into `param` (default `q`). Waits for a pause in typing, and replaces history rather than adding to it. */
export function SearchBox({ label, placeholder, param = "q" }: { label: string; placeholder?: string; param?: string }) {
  const { set, pending, searchParams } = useSetParam();
  const current = searchParams.get(param) ?? "";
  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Back/forward or Clear changes the URL under us: follow it (adjusting state during render).
  if (current !== synced) {
    setSynced(current);
    setValue(current);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  const onChange = (next: string) => {
    setValue(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => set({ [param]: next.trim().slice(0, 100) || null }, "replace"), 300);
  };

  return (
    <label className="relative flex items-center">
      <span className="sr-only">{label}</span>
      <Search className="pointer-events-none absolute left-2.5 size-4 text-muted" aria-hidden />
      <input
        type="search"
        value={value}
        maxLength={100}
        placeholder={placeholder ?? label}
        onChange={(e) => onChange(e.target.value)}
        className={cn(fieldClass, "w-56 pl-8 pr-8")}
      />
      {pending && <Loader2 className="absolute right-2.5 size-4 animate-spin text-muted" aria-hidden />}
    </label>
  );
}

/** A single-choice select into `param`; the empty option removes it. */
export function SelectFilter({
  label,
  param,
  options,
  allLabel = "All",
}: {
  label: string;
  param: string;
  options: { value: string; label: string }[];
  allLabel?: string;
}) {
  const { set, searchParams } = useSetParam();
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      {label}
      <select value={searchParams.get(param) ?? ""} onChange={(e) => set({ [param]: e.target.value || null })} className={fieldClass}>
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** `from` and `to` date inputs (UTC days, inclusive). */
export function DateRange({ label, fromParam = "from", toParam = "to" }: { label: string; fromParam?: string; toParam?: string }) {
  const { set, searchParams } = useSetParam();
  return (
    <fieldset className="flex items-center gap-2 text-sm text-muted">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden>{label}</span>
      <input
        type="date"
        aria-label={`${label} from`}
        value={searchParams.get(fromParam) ?? ""}
        max={searchParams.get(toParam) ?? undefined}
        onChange={(e) => set({ [fromParam]: e.target.value || null })}
        className={fieldClass}
      />
      <span aria-hidden>–</span>
      <input
        type="date"
        aria-label={`${label} to`}
        value={searchParams.get(toParam) ?? ""}
        min={searchParams.get(fromParam) ?? undefined}
        onChange={(e) => set({ [toParam]: e.target.value || null })}
        className={fieldClass}
      />
    </fieldset>
  );
}

/**
 * The toolbar around a list's filters. On narrow screens it folds behind a **Filters** button
 * showing how many are active, so tables keep their width; from `sm` up it is always open.
 */
export function FilterBar({ active, children }: { active: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mb-2 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-muted sm:hidden"
      >
        {open ? <X className="size-4" aria-hidden /> : <SlidersHorizontal className="size-4" aria-hidden />}
        Filters{active > 0 && <span className="tabular-nums text-foreground">({active})</span>}
      </button>
      <div className={cn("flex-wrap items-center gap-3", open ? "flex" : "hidden sm:flex")}>{children}</div>
    </div>
  );
}
