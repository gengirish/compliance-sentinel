import Link from "next/link";
import { ArrowRight, FileText } from "lucide-react";
import { FindingCard } from "@/components/finding-card";
import { EmptyState, PageHeader } from "@/components/page-header";
import { RunAuditButton } from "@/components/run-audit-button";
import { RunStatusBadge } from "@/components/status-badges";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { cn, formatDateTime, formatDuration, formatUsd } from "@/lib/utils";

const OVERVIEW_LIMIT = 3;

export default async function OverviewPage() {
  const stats = await api.stats();
  const latest = stats.latestCompletedRun;
  const counts = latest?.counts;
  const critical = latest ? await api.findings(latest.id, { status: ["violation"], severity: ["critical"] }) : [];

  const tiles = [
    { label: "Violations", value: counts?.byStatus.violation, className: "text-danger" },
    { label: "Critical violations", value: counts?.criticalViolations, className: "text-danger" },
    { label: "Needs review", value: counts?.byStatus.needs_review, className: "text-warning" },
    { label: "Compliant", value: counts?.byStatus.compliant, className: "text-success" },
  ];

  return (
    <>
      <PageHeader
        title="Overview"
        description={`${stats.totals.rules} rules tracked across ${stats.totals.runs} audit runs.`}
        actions={<RunAuditButton />}
      />

      {!latest ? (
        <EmptyState title="No completed audits yet">
          Click <strong>Run audit</strong>, or run <code className="font-mono">pnpm audit:run --demo</code> in the repo root.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          <section aria-label={`Findings from run ${latest.id}`} className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {tiles.map((t) => (
              <Card key={t.label}>
                <CardTitle>{t.label}</CardTitle>
                <p className={cn("mt-2 text-3xl font-bold tabular-nums sm:text-4xl", t.className)}>{t.value ?? 0}</p>
              </Card>
            ))}
          </section>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="h-fit min-w-0 lg:col-span-1">
              <CardTitle>Latest audit</CardTitle>
              <dl className="mt-4 space-y-3 text-sm">
                <Row label="Run">
                  <Link href={`/runs/${latest.id}`} className="font-medium text-accent hover:underline">
                    #{latest.id}
                  </Link>
                </Row>
                <Row label="Status">
                  <RunStatusBadge status={latest.status} />
                </Row>
                <Row label="Finished">{latest.finishedAt ? formatDateTime(latest.finishedAt) : "—"}</Row>
                <Row label="Duration">{formatDuration(latest.startedAt, latest.finishedAt)}</Row>
                <Row label="Rules in scope">{latest.rulesInScope.length}</Row>
                <Row label="Model cost">{formatUsd(latest.costUsd)}</Row>
              </dl>
              <div className="mt-5 flex flex-wrap gap-2">
                <Link href={`/runs/${latest.id}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                  All findings <ArrowRight className="size-3.5" aria-hidden />
                </Link>
                {latest.reportUrl && (
                  <a
                    href={`/api/reports/${latest.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    <FileText className="size-3.5" aria-hidden /> Report
                  </a>
                )}
              </div>
              {stats.latestRun && stats.latestRun.id !== latest.id && (
                <p className="mt-4 flex items-center gap-2 border-t border-border pt-4 text-xs text-muted">
                  Newer run #{stats.latestRun.id}: <RunStatusBadge status={stats.latestRun.status} />
                </p>
              )}
            </Card>

            <section className="min-w-0 space-y-4 lg:col-span-2">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Critical violations</h2>
                {critical.length > OVERVIEW_LIMIT && (
                  <Link
                    href={`/runs/${latest.id}?status=violation&severity=critical`}
                    className="text-sm text-accent hover:underline"
                  >
                    View all {critical.length}
                  </Link>
                )}
              </div>
              {critical.length === 0 ? (
                <EmptyState title="No critical violations in the latest audit" />
              ) : (
                critical.slice(0, OVERVIEW_LIMIT).map((f) => <FindingCard key={f.id} finding={f} />)
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
