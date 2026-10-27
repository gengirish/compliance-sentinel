import { ExternalLink, FileCode2, Scale } from "lucide-react";
import { FindingStatusBadge, SeverityBadge } from "@/components/status-badges";
import type { Finding } from "@/lib/api";

/**
 * One finding. `headingLevel` is the level of the obligation heading; the Regulation and
 * Code evidence headings sit one below it. The default (3) fits a list under an h2.
 * With the run's GitHub `repoUrl` and audited commit `sha`, each code location links to the
 * file on GitHub at that commit.
 */
export function FindingCard({
  finding,
  headingLevel = 3,
  repoUrl,
  sha,
}: {
  finding: Finding;
  headingLevel?: 2 | 3;
  repoUrl?: string;
  sha?: string;
}) {
  const Title = `h${headingLevel}` as const;
  const Section = `h${headingLevel + 1}` as "h3" | "h4";

  return (
    <article className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <FindingStatusBadge status={finding.status} />
        <SeverityBadge severity={finding.severity} />
        <a
          href={finding.rule.url}
          target="_blank"
          rel="noreferrer"
          title={finding.rule.title}
          className="inline-flex min-w-0 max-w-full items-center gap-1 text-xs text-muted hover:text-accent"
        >
          <span className="truncate">{finding.rule.title}</span>
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </a>
      </div>

      <Title className="mt-3 font-semibold leading-snug break-words">{finding.obligation}</Title>
      <p className="mt-2 text-sm text-muted">{finding.rationale}</p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="min-w-0">
          <Section className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <Scale className="size-3.5" aria-hidden /> Regulation
          </Section>
          {finding.citations.length === 0 ? (
            <p className="text-sm text-muted">
              {finding.citationChunkIds.length > 0
                ? "The cited section is no longer stored: the rule text was re-indexed after this run. See the PDF report."
                : "No verified citation."}
            </p>
          ) : (
            <ul className="space-y-2">
              {finding.citations.map((c, i) => (
                <li key={c.id}>
                  {/* The evidence is the point of a finding, so the first of each kind starts open. */}
                  <details open={i === 0} className="rounded-lg bg-surface-light/60 px-3 py-2 text-sm">
                    <summary className="-my-2 py-3.5 font-medium">{c.sectionRef ?? `Chunk ${c.id}`}</summary>
                    <p className="mt-2 whitespace-pre-line text-muted">{c.excerpt}</p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-w-0">
          <Section className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <FileCode2 className="size-3.5" aria-hidden /> Code evidence
          </Section>
          {finding.evidence.length === 0 ? (
            <p className="text-sm text-muted">No code location.</p>
          ) : (
            <ul className="space-y-2">
              {finding.evidence.map((e, i) => {
                const href = repoUrl && sha ? githubLineUrl(repoUrl, sha, e.path, e.start_line, e.end_line) : undefined;
                const lines = e.end_line === e.start_line ? `line ${e.start_line}` : `lines ${e.start_line}–${e.end_line}`;
                return (
                  <li key={`${e.path}:${e.start_line}`} className="relative">
                    <details open={i === 0} className="rounded-lg bg-surface-light/60 px-3 py-2 text-sm">
                      <summary className={`-my-2 py-3.5 break-all font-mono text-xs text-accent ${href ? "pr-10" : ""}`}>
                        {e.path}:{e.start_line}
                        {e.end_line !== e.start_line && `-${e.end_line}`}
                      </summary>
                      <CodeExcerpt code={e.excerpt} startLine={e.start_line} />
                    </details>
                    {/* Beside the summary, not inside it, so following the link never toggles the excerpt. */}
                    {href && (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${e.path} ${lines} on GitHub`}
                        title="Open on GitHub"
                        className="absolute right-0 top-0 inline-flex size-11 items-center justify-center rounded-lg text-muted hover:text-accent"
                      >
                        <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </article>
  );
}

/** `repoUrl/blob/sha/path#Lstart-Lend`, or just `#Lstart` for a single line. */
function githubLineUrl(repoUrl: string, sha: string, filePath: string, start: number, end: number): string {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const anchor = end === start ? `#L${start}` : `#L${start}-L${end}`;
  return `${repoUrl.replace(/\/$/, "")}/blob/${sha}/${encodedPath}${anchor}`;
}

/** The excerpt with its file line numbers in a gutter that is neither selected nor read out. */
function CodeExcerpt({ code, startLine }: { code: string; startLine: number }) {
  const text = code.replace(/\n$/, "");
  const lineCount = text.split("\n").length;
  const numbers = Array.from({ length: lineCount }, (_, i) => startLine + i).join("\n");

  return (
    <div className="mt-2 flex overflow-x-auto font-mono text-xs leading-relaxed">
      <pre aria-hidden className="shrink-0 select-none pr-3 text-right text-muted/70">
        {numbers}
      </pre>
      <pre className="grow text-foreground/90">
        <code>{text}</code>
      </pre>
    </div>
  );
}
