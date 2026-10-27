import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { UserMenu } from "@/components/auth/user-menu";
import { Nav } from "@/components/nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface-light focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-foreground"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-4">
          <Link href="/overview" prefetch={false} className="flex items-center gap-2 font-bold">
            <ShieldCheck className="size-5 text-primary-light" aria-hidden />
            <span className="gradient-text hidden md:inline">Compliance Sentinel</span>
          </Link>
          <Nav />
          <div className="ml-auto">
            <UserMenu />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8 focus:outline-none">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted">
        Decision support, not legal advice. Findings do not guarantee compliance or complete coverage of any regulation.
      </footer>
    </div>
  );
}
