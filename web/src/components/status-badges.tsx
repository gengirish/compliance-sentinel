import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { FindingStatus, Run, Severity } from "@/lib/api";

export const STATUS_LABEL: Record<FindingStatus, string> = {
  violation: "Violation",
  needs_review: "Needs review",
  compliant: "Compliant",
};

const STATUS_TONE: Record<FindingStatus, BadgeTone> = {
  violation: "danger",
  needs_review: "warning",
  compliant: "success",
};

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
};

const RUN_TONE: Record<Run["status"], BadgeTone> = {
  running: "info",
  completed: "success",
  skipped: "neutral",
  failed: "danger",
};

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{severity[0]!.toUpperCase() + severity.slice(1)}</Badge>;
}

export function RunStatusBadge({ status }: { status: Run["status"] }) {
  return (
    <Badge tone={RUN_TONE[status]}>
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden />}
      {status[0]!.toUpperCase() + status.slice(1)}
    </Badge>
  );
}
