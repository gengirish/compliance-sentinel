import type { Metadata } from "next";
import { RetryButton } from "./retry-button";

// Precached by public/sw.js and served for any navigation that fails offline.
// Lives outside (dashboard) so it has no auth check and no data.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Offline",
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="gradient-text text-4xl font-bold">You&apos;re offline</p>
      <p className="max-w-sm text-muted">
        Sentinel can&apos;t reach the network. Findings and audit runs need a connection, so
        reconnect and try again.
      </p>
      <RetryButton />
    </main>
  );
}
