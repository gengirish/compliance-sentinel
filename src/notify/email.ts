import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { NotifyInput } from "../graph/state.js";
import { log } from "../log.js";
import { AgentMailClient, type Attachment } from "./agentmail.js";

/** AgentMail caps a request at 6 MB; leave room for the body. */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function buildEmail(input: NotifyInput): { subject: string; html: string; text: string } {
  const critical = input.findings.filter((f) => f.status === "violation" && f.severity === "critical");
  const { byStatus, violationsBySeverity: sev } = input.summary;
  const subject = `[Compliance Sentinel] ${critical.length} critical violation${critical.length === 1 ? "" : "s"} in audit run ${input.runId}`;
  const where = (finding: NotifyInput["findings"][number]) => {
    const location = finding.evidence[0];
    return location ? `${location.path}:${location.start_line}` : "";
  };
  const items = critical
    .map((finding) => `<li>${escapeHtml(finding.obligation)}${where(finding) ? ` <code>${escapeHtml(where(finding))}</code>` : ""}</li>`)
    .join("");
  const isLink = !!input.reportUrl && /^https?:\/\//.test(input.reportUrl);
  const link = isLink
    ? `<p><a href="${escapeHtml(input.reportUrl!)}">Open the full report</a> (link expires in 7 days).</p>`
    : input.reportUrl
      ? `<p>Report stored at <code>${escapeHtml(input.reportUrl)}</code>.</p>`
      : "";
  const summary = `Audit run ${input.runId} found ${byStatus.violation} violation(s): ${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low. ${byStatus.needs_review} item(s) need human review.`;
  const html = `<p>${summary}</p>
<p><strong>Critical findings</strong></p>
<ul>${items}</ul>
${link}
<p style="color:#6b7280;font-size:12px">Automated decision support, not legal advice.</p>`;
  const text = [
    summary,
    "",
    "Critical findings:",
    ...critical.map((finding) => `- ${finding.obligation}${where(finding) ? ` (${where(finding)})` : ""}`),
    "",
    isLink ? `Full report: ${input.reportUrl} (link expires in 7 days)` : input.reportUrl ? `Report stored at ${input.reportUrl}` : "",
    "Automated decision support, not legal advice.",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  return { subject, html, text };
}

/** The rendered PDF, when it exists locally and is small enough to send inline. */
export function reportAttachment(reportPath: string | null | undefined): Attachment | null {
  if (!reportPath || !reportPath.toLowerCase().endsWith(".pdf")) return null;
  try {
    if (statSync(reportPath).size > MAX_ATTACHMENT_BYTES) {
      log.warn("report too large to attach to the alert email", { reportPath });
      return null;
    }
    return { filename: path.basename(reportPath), content_type: "application/pdf", content: readFileSync(reportPath).toString("base64") };
  } catch {
    return null;
  }
}

/**
 * Sends the alert from the app's AgentMail inbox, with the PDF attached when
 * it is on disk. Returns false in dry-run mode, when AgentMail or the
 * recipients are not configured.
 */
export async function sendEmailAlert(input: NotifyInput, client: AgentMailClient | null = AgentMailClient.fromConfig()): Promise<boolean> {
  const { subject, html, text } = buildEmail(input);
  if (!client || !config.ALERT_EMAIL_TO) {
    log.info("email dry run: AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID or ALERT_EMAIL_TO not set", { subject });
    return false;
  }
  const attachment = reportAttachment(input.reportPath);
  const sent = await client.send({
    to: config.ALERT_EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
    subject,
    text,
    html,
    ...(attachment ? { attachments: [attachment] } : {}),
  });
  log.info("alert email sent", { from: client.inboxId, messageId: sent.messageId, attached: !!attachment });
  return true;
}
