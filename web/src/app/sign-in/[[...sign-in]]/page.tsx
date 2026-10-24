import { SignIn } from "@clerk/nextjs";
import { ShieldCheck } from "lucide-react";
import { isE2EBypass } from "@/lib/utils";

function safeRedirectUrl(raw?: string): string {
  return raw?.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ redirect_url?: string }> }) {
  const { redirect_url } = await searchParams;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6 py-12">
      <div className="flex items-center gap-3">
        <ShieldCheck className="size-8 text-primary-light" aria-hidden />
        <div>
          <p className="text-xl font-bold">
            <span className="gradient-text">Compliance Sentinel</span>
          </p>
          <p className="text-sm text-muted">by IntelliForge AI</p>
        </div>
      </div>
      {isE2EBypass() ? (
        <h1 className="text-2xl font-bold">Sign in</h1>
      ) : (
        <SignIn forceRedirectUrl={safeRedirectUrl(redirect_url)} />
      )}
    </main>
  );
}
