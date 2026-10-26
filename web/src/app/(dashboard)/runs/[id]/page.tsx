import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText } from "lucide-react";
import { FindingCard } from "@/components/finding-card";
import { EmptyState, PageHeader } from "@/components/page-header";
import { RefreshWhile } from "@/components/refresh-while";
import { RunStatusBadge, STATUS_LABEL } from "@/components/status-badges";
import { buttonVariants } from "@/components/ui/button";
import { ApiError, api, FINDING_STATUSES, SEVERITIES, type Run } from "@/lib/api";
import { cn, formatDateTime, formatDuration, formatUsd } from "@/lib/utils";

type Params = { id: string };
type Search = { status?: string; severity?: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  return { title: `Run #${(await params).id}` };
}

function pick<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  return (raw ?? "").split(",").filter((v): v is T => (allowed as readonly string[]).includes(v));
}

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const search = await searchParams;
  const status = pick(search.status, FINDING_STATUSES);
  const severity = pick(search.severity, SEVERITIES);

  let run: Run;
  try {
    run = await api.run(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const findings = await api.findings(id, { status, severity });

  /** Link that toggles one filter value and keeps the rest. */
  const toggle = (key: keyof Search, value: string) => {
    const flip = (list: string[]) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
    const s = key === "status" ? flip(status) : status;
    const v = key === "severity" ? flip(severity) : severity;
    const q = new URLSearchParams();
    if (s.length) q.set("status", s.join(","));
    if (v.length) q.set("severity", v.join(","));
    const qs = q.toString();
    return `/runs/${id}${qs ? `?${qs}` : ""}`;
  };

  return (
    <>
      <Link href="/runs" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All runs
      </Link>
      <RefreshWhile active={run.status === "running"} />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Run #{run.id} <RunStatusBadge status={run.status} />
          </span>
        }
        description={`${run.trigger === "cron" ? "Scheduled" : "Manual"} · started ${formatDateTime(run.startedAt)} · ${formatDuration(run.startedAt, run.finishedAt)} · ${run.rulesInScope.length} rules · ${formatUsd(run.costUsd)}`}
        actions={
          run.reportUrl && (
            <a
              href={`/api/reports/${run.id}`}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "secondary" })}
            >
              <FileText className="size-4" aria-hidden /> Open report
            </a>
          )
        }
      />

      {run.error && (
        <p className="mb-6 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{run.error}</p>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-2" role="group" aria-label="Filter findings">
        {FINDING_STATUSES.map((s) => (
          <FilterChip key={s} href={toggle("status", s)} active={status.includes(s)}>
            {STATUS_LABEL[s]} <span className="tabular-nums text-muted">{run.counts?.byStatus[s] ?? 0}</span>
          </FilterChip>
        ))}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        {SEVERITIES.map((s) => (
          <FilterChip key={s} href={toggle("severity", s)} active={severity.includes(s)}>
            {s[0]!.toUpperCase() + s.slice(1)}{" "}
            <span className="tabular-nums text-muted">{run.counts?.bySeverity[s] ?? 0}</span>
          </FilterChip>
        ))}
        {(status.length > 0 || severity.length > 0) && (
          <Link href={`/runs/${id}`} className="ml-1 text-sm text-muted hover:text-foreground">
            Clear
          </Link>
        )}
      </div>

      {findings.length === 0 ? (
        <EmptyState title={run.counts?.total ? "No findings match these filters" : "This run produced no findings"} />
      ) : (
        <div className="space-y-4">
          {findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      )}
    </>
  );
}

function FilterChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      scroll={false}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm",
        active
          ? "border-primary-light/50 bg-primary/20 text-foreground"
          : "border-border text-muted hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
