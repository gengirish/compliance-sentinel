import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** The centred card the public digest pages (confirm, unsubscribe) show their outcome in. */
export function DigestMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <Card className="w-full max-w-md text-center">
        <ShieldCheck className="mx-auto size-6 text-primary-light" aria-hidden />
        <h1 className="mt-4 text-xl font-bold tracking-tight">{title}</h1>
        <div className="mt-3 space-y-4 text-sm text-muted">{children}</div>
        <Link href="/" className={buttonVariants({ variant: "ghost", size: "sm", className: "mt-6" })}>
          Back to Compliance Sentinel
        </Link>
      </Card>
    </main>
  );
}
