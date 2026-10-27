"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { History, LayoutDashboard, ScrollText, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/runs", label: "Runs", icon: History },
  { href: "/rules", label: "Rules", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-0.5 sm:gap-1">
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            // Every refresh re-prefetched all nav links, the current page included, which raced
            // the refresh itself and added a server render apiece (DEF-003, DEF-004).
            prefetch={false}
            aria-current={active ? "page" : undefined}
            // Below sm the label sits under the icon so all four links stay labelled and fit at 375px.
            className={cn(
              "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-1 text-[11px] font-medium leading-none sm:flex-row sm:gap-2 sm:px-3 sm:py-2 sm:text-sm",
              active ? "bg-surface-light text-foreground" : "text-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
