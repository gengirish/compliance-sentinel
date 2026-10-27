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
    <nav aria-label="Main" className="flex gap-1">
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
            aria-label={label}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium",
              active ? "bg-surface-light text-foreground" : "text-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            <span className="hidden sm:inline">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
