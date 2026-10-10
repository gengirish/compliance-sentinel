import { config } from "../config.js";
import type { NotifyInput } from "../graph/state.js";
import { log } from "../log.js";

function isLink(value: string | null): value is string {
  return Boolean(value && /^https?:\/\//.test(value));
}

/** Builds the Block Kit payload for a critical-findings alert. */
export function buildSlackMessage(input: NotifyInput) {
  const critical = input.findings.filter((f) => f.status === "violation" && f.severity === "critical");
  const { violationsBySeverity: sev, byStatus } = input.summary;
  const headline = `${critical.length} critical compliance violation${critical.length === 1 ? "" : "s"} found`;

  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: `🚨 ${headline}`, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Run:* ${input.runId}` },
        { type: "mrkdwn", text: `*Violations:* ${byStatus.violation} (${sev.critical} critical, ${sev.high} high)` },
        { type: "mrkdwn", text: `*Needs review:* ${byStatus.needs_review}` },
        { type: "mrkdwn", text: `*Compliant:* ${byStatus.compliant}` },
      ],
    },
    { type: "divider" },
    ...critical.slice(0, 5).map((finding) => {
      const location = finding.evidence[0];
      const where = location ? `\n\`${location.path}:${location.start_line}\`` : "";
      return {
        type: "section",
        text: { type: "mrkdwn", text: `*${finding.obligation.slice(0, 220)}*${where}` },
      };
    }),
  ];
  if (critical.length > 5) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `…and ${critical.length - 5} more in the report.` }] });
  }
  if (isLink(input.reportUrl)) {
    blocks.push({
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Open report" }, url: input.reportUrl, style: "primary" }],
    });
  } else if (input.reportUrl) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Report: \`${input.reportUrl}\`` }] });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Automated decision support, not legal advice." }],
  });

  return { text: `${headline} (audit run ${input.runId})`, blocks };
}

/** Posts the alert. Returns false in dry-run mode, when no webhook is configured. */
export async function sendSlackAlert(input: NotifyInput, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const message = buildSlackMessage(input);
  if (!config.SLACK_WEBHOOK_URL) {
    log.info("slack dry run: SLACK_WEBHOOK_URL not set", { message: message.text });
    return false;
  }
  const res = await fetchImpl(config.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Slack webhook HTTP ${res.status}: ${await res.text()}`);
  return true;
}
