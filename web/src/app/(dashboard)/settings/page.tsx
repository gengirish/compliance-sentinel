import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page-header";
import { SourceSwitch } from "@/components/source-switch";
import { Badge } from "@/components/ui/badge";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  let sources;
  try {
    sources = await api.sources();
  } catch (err) {
    // The API keeps the switches to the operator; anyone else gets an explanation, not an error page.
    if (err instanceof ApiError && err.status === 403) {
      return (
        <>
          <PageHeader title="Settings" />
          <EmptyState title="Only the operator can configure sources" />
        </>
      );
    }
    throw err;
  }
  const enabled = sources.filter((s) => s.enabled).length;

  return (
    <>
      <PageHeader
        title="Regulatory sources"
        description="Choose which portals are scraped. A change applies from the next run, scheduled or manual. Rules already collected from a source you switch off are kept, but stop being updated or audited. The bundled demo rules are not affected."
      />
      {enabled === 0 && (
        <p role="status" className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          Every source is off, so scheduled runs will find nothing new and be skipped.
        </p>
      )}
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {sources.map((s) => (
          <li key={s.name} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium hover:text-accent"
                >
                  {s.label}
                  <ExternalLink className="size-3 shrink-0" aria-hidden />
                </a>
                <Badge tone="neutral">{s.region}</Badge>
                {s.overridden ? (
                  <Badge tone="info" title={`Set on this page${s.updatedAt ? ` on ${formatDateTime(s.updatedAt)}` : ""}`}>
                    Set here
                  </Badge>
                ) : (
                  <Badge tone="neutral" title="No switch saved yet; the SCRAPE_* environment flag decides">
                    Default
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-muted">{s.description}</p>
              <p className="mt-1 text-xs text-muted">
                {s.rules} {s.rules === 1 ? "rule" : "rules"} collected · last checked{" "}
                {s.lastCheckedAt ? formatDateTime(s.lastCheckedAt) : "never"}
                {s.requires && <> · needs {s.requires}</>}
              </p>
            </div>
            <SourceSwitch
              name={s.name}
              label={s.label}
              enabled={s.enabled}
              defaultEnabled={s.defaultEnabled}
              overridden={s.overridden}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
