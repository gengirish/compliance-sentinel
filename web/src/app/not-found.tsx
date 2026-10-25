import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="gradient-text text-5xl font-bold">404</p>
      <p className="text-muted">That page or run doesn&apos;t exist.</p>
      <Link href="/overview" className={buttonVariants({ variant: "secondary", size: "sm" })}>
        Back to overview
      </Link>
    </main>
  );
}
