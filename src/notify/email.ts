import { config } from "../config.js";
import type { NotifyInput } from "../graph/state.js";
import { log } from "../log.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function buildEmail(input: NotifyInput): { subject: string; html: string } {
  const critical = input.findings.filter((f) => f.status === "violation" && f.severity === "critical");
  const { byStatus, violationsBySeverity: sev } = input.summary;
  const subject = `[Compliance Sentinel] ${critical.length} critical violation${critical.length === 1 ? "" : "s"} in audit run ${input.runId}`;
  const items = critical
    .map((finding) => {
      const location = finding.evidence[0];
      const where = location ? ` <code>${escapeHtml(location.path)}:${location.start_line}</code>` : "";
      return `<li>${escapeHtml(finding.obligation)}${where}</li>`;
    })
    .join("");
  const link =
    input.reportUrl && /^https?:\/\//.test(input.reportUrl)
      ? `<p><a href="${escapeHtml(input.reportUrl)}">Open the full report</a> (link expires in 7 days).</p>`
      : input.reportUrl
        ? `<p>Report stored at <code>${escapeHtml(input.reportUrl)}</code>.</p>`
        : "";
  const html = `<p>Audit run ${input.runId} found ${byStatus.violation} violation(s): ${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low. ${byStatus.needs_review} item(s) need human review.</p>
<p><strong>Critical findings</strong></p>
<ul>${items}</ul>
${link}
<p style="color:#6b7280;font-size:12px">Automated decision support, not legal advice.</p>`;
  return { subject, html };
}

/** Sends the alert through Resend. Returns false in dry-run mode, when it is not configured. */
export async function sendEmailAlert(input: NotifyInput, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const { subject, html } = buildEmail(input);
  if (!config.RESEND_API_KEY || !config.ALERT_EMAIL_TO) {
    log.info("email dry run: RESEND_API_KEY or ALERT_EMAIL_TO not set", { subject });
    return false;
  }
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: config.ALERT_EMAIL_FROM,
      to: config.ALERT_EMAIL_TO.split(",").map((s) => s.trim()),
      subject,
      html,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${await res.text()}`);
  return true;
}
