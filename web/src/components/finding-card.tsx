import { ExternalLink, FileCode2, Scale } from "lucide-react";
import { FindingStatusBadge, SeverityBadge } from "@/components/status-badges";
import type { Finding } from "@/lib/api";

export function FindingCard({ finding }: { finding: Finding }) {
  return (
    <article className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <FindingStatusBadge status={finding.status} />
        <SeverityBadge severity={finding.severity} />
        <a
          href={finding.rule.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1 text-xs text-muted hover:text-accent"
        >
          <span className="truncate">{finding.rule.title}</span>
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </a>
      </div>

      <h3 className="mt-3 font-semibold leading-snug">{finding.obligation}</h3>
      <p className="mt-2 text-sm text-muted">{finding.rationale}</p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <Scale className="size-3.5" aria-hidden /> Regulation
          </h4>
          {finding.citations.length === 0 ? (
            <p className="text-sm text-muted">No verified citation.</p>
          ) : (
            <ul className="space-y-2">
              {finding.citations.map((c) => (
                <li key={c.id}>
                  <details className="rounded-lg bg-surface-light/60 px-3 py-2 text-sm">
                    <summary className="font-medium">{c.sectionRef ?? `Chunk ${c.id}`}</summary>
                    <p className="mt-2 whitespace-pre-line text-muted">{c.excerpt}</p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <FileCode2 className="size-3.5" aria-hidden /> Code evidence
          </h4>
          {finding.evidence.length === 0 ? (
            <p className="text-sm text-muted">No code location.</p>
          ) : (
            <ul className="space-y-2">
              {finding.evidence.map((e) => (
                <li key={`${e.path}:${e.start_line}`}>
                  <details className="rounded-lg bg-surface-light/60 px-3 py-2 text-sm">
                    <summary className="font-mono text-xs text-accent">
                      {e.path}:{e.start_line}
                      {e.end_line !== e.start_line && `-${e.end_line}`}
                    </summary>
                    <pre className="mt-2 overflow-x-auto font-mono text-xs leading-relaxed text-foreground/90">
                      {e.excerpt}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </article>
  );
}
