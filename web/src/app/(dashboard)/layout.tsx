import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";

// Every dashboard page reads live audit data.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <AppShell>{children}</AppShell>;
}
