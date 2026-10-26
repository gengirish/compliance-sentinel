import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Rules" };

export default async function RulesPage() {
  const rules = await api.rules();

  return (
    <>
      <PageHeader
        title="Tracked rules"
        description="Regulations collected from the Federal Register, the SEC, FINRA, the FCA, ESMA, ASIC, EUR-Lex and MAS. A rule is re-audited when its text changes."
      />
      {rules.length === 0 ? (
        <EmptyState title="No rules collected yet" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Rule</th>
                <th className="px-4 py-3 font-semibold">Source</th>
                <th className="px-4 py-3 font-semibold">Effective</th>
                <th className="px-4 py-3 font-semibold">Last changed</th>
                <th className="px-4 py-3 font-semibold">Last audited</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map((r) => (
                <tr key={r.id} className="align-top hover:bg-surface/60">
                  <td className="max-w-md px-4 py-3">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-start gap-1 font-medium hover:text-accent"
                    >
                      {r.title}
                      <ExternalLink className="mt-1 size-3 shrink-0" aria-hidden />
                    </a>
                    <p className="font-mono text-xs text-muted">{r.externalId}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={r.source.kind === "fixture" ? "neutral" : "primary"}>{r.source.name}</Badge>
                  </td>
                  <td className="px-4 py-3 text-muted">{r.effectiveDate ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">{formatDateTime(r.lastChangedAt)}</td>
                  <td className="px-4 py-3">
                    {r.lastAuditedRunId ? (
                      <Link href={`/runs/${r.lastAuditedRunId}`} prefetch={false} className="text-accent hover:underline">
                        Run #{r.lastAuditedRunId}
                      </Link>
                    ) : (
                      <span className="text-muted">Not yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
