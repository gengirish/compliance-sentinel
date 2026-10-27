import { config } from "../config.js";
import { errorMessage, log } from "../log.js";
import { AgentMailClient } from "../notify/agentmail.js";
import type { RuleDigestRecord } from "./digestRule.js";
import { escapeHtml, unsubscribeUrl, type Subscriber } from "./subscribers.js";

/** A round-up of rule changes over a period, ready to render for people. */
export type DigestReport = {
  /** ISO dates, inclusive. */
  from: string;
  to: string;
  records: RuleDigestRecord[];
  costUsd: number;
};

function bySource(records: RuleDigestRecord[]): Map<string, RuleDigestRecord[]> {
  const groups = new Map<string, RuleDigestRecord[]>();
  for (const record of records) {
    const list = groups.get(record.source) ?? [];
    list.push(record);
    groups.set(record.source, list);
  }
  return groups;
}

export function digestHeadline(report: DigestReport): string {
  const n = report.records.length;
  const amended = report.records.filter((r) => r.kind === "amended").length;
  const detail = n === 0 ? "no rule changes" : `${n} rule change${n === 1 ? "" : "s"}${amended ? ` (${amended} amended)` : ""}`;
  return `Regulatory digest, ${report.from} to ${report.to}: ${detail}`;
}

/** Markdown for the terminal and the Slack fallback text. */
export function buildDigestMarkdown(report: DigestReport): string {
  const lines = [`# ${digestHeadline(report)}`, ""];
  if (report.records.length === 0) lines.push("No tracked rule was added or amended in this period.");
  for (const [source, records] of bySource(report.records)) {
    lines.push(`## ${source}`, "");
    for (const r of records) {
      lines.push(`### ${r.title}`, `${r.kind === "amended" ? "Amended" : "New"} · effective ${r.digest.effective_date ?? r.effectiveDate ?? "not stated"} · ${r.url}`, "");
      lines.push(r.digest.summary, "", `**What changed:** ${r.digest.what_changed}`, `**Applies to:** ${r.digest.applies_to}`, "", "**Key obligations:**");
      for (const duty of r.digest.key_obligations) lines.push(`- ${duty}`);
      lines.push("");
    }
  }
  lines.push("_Automated summary of the rule text, not legal advice._");
  return lines.join("\n");
}

/** The email body; with `unsubscribe`, a footer linking to that subscriber's unsubscribe page. */
export function buildDigestEmail(report: DigestReport, unsubscribe?: string): { subject: string; html: string; text: string } {
  const subject = `[Compliance Sentinel] ${digestHeadline(report)}`;
  const sections: string[] = [];
  if (report.records.length === 0) sections.push("<p>No tracked rule was added or amended in this period.</p>");
  for (const [source, records] of bySource(report.records)) {
    sections.push(`<h2 style="font-size:16px;margin:24px 0 8px">${escapeHtml(source)}</h2>`);
    for (const r of records) {
      const effective = r.digest.effective_date ?? r.effectiveDate ?? "not stated";
      sections.push(
        `<h3 style="font-size:15px;margin:16px 0 4px"><a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a></h3>`,
        `<p style="color:#6b7280;font-size:12px;margin:0 0 8px">${r.kind === "amended" ? "Amended" : "New"} · effective ${escapeHtml(effective)} · ${escapeHtml(r.source)}</p>`,
        `<p>${escapeHtml(r.digest.summary)}</p>`,
        `<p><strong>What changed:</strong> ${escapeHtml(r.digest.what_changed)}<br><strong>Applies to:</strong> ${escapeHtml(r.digest.applies_to)}</p>`,
        `<p><strong>Key obligations</strong></p><ul>${r.digest.key_obligations.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`,
      );
    }
  }
  const html = `<p>${escapeHtml(digestHeadline(report))}.</p>
${sections.join("\n")}
<p style="color:#6b7280;font-size:12px">Automated summary of the rule text, not legal advice.</p>`;
  if (!unsubscribe) return { subject, html, text: buildDigestMarkdown(report) };
  return {
    subject,
    html: `${html}\n<p style="color:#6b7280;font-size:12px">You receive this because you subscribed to the weekly digest. <a href="${escapeHtml(unsubscribe)}">Unsubscribe</a></p>`,
    text: `${buildDigestMarkdown(report)}\n\nUnsubscribe: ${unsubscribe}`,
  };
}

/** Block Kit payload: the headline, then one section per rule (at most ten), then a note on the rest. */
export function buildDigestSlack(report: DigestReport) {
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: `📋 ${digestHeadline(report)}`, emoji: true } },
  ];
  if (report.records.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "No tracked rule was added or amended in this period." } });
  }
  for (const r of report.records.slice(0, 10)) {
    const duties = r.digest.key_obligations.slice(0, 3).map((d) => `• ${d}`).join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${r.url}|${r.title.slice(0, 150)}>*  _${r.kind === "amended" ? "amended" : "new"} · ${r.source} · effective ${r.digest.effective_date ?? r.effectiveDate ?? "not stated"}_\n${r.digest.summary.slice(0, 400)}\n${duties}`,
      },
    });
  }
  if (report.records.length > 10) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `…and ${report.records.length - 10} more in the email digest.` }] });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Automated summary of the rule text, not legal advice." }] });
  return { text: digestHeadline(report), blocks };
}

export type DeliverOptions = {
  mail?: AgentMailClient | null;
  fetchImpl?: typeof fetch;
  /** Confirmed website subscribers; each gets their own copy with an unsubscribe link. */
  subscribers?: Subscriber[];
};

/**
 * Sends the digest to every configured channel: the AgentMail inbox to the
 * alert recipients and to each subscriber, and the Slack webhook. Returns the channels that
 * delivered; an unconfigured channel is a logged dry run, a failing one does not stop the others.
 */
export async function deliverDigest(report: DigestReport, opts: DeliverOptions = {}): Promise<string[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const mail = opts.mail === undefined ? AgentMailClient.fromConfig({ fetchImpl }) : opts.mail;
  const delivered: string[] = [];

  const email = buildDigestEmail(report);
  const team = (config.ALERT_EMAIL_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (mail && team.length > 0) {
    try {
      const sent = await mail.send({ to: team, ...email });
      log.info("digest email sent", { from: mail.inboxId, messageId: sent.messageId, rules: report.records.length });
      delivered.push("email");
    } catch (err) {
      log.error("digest email failed", { error: errorMessage(err) });
    }
  } else {
    log.info("digest email dry run: AgentMail or ALERT_EMAIL_TO not set", { subject: email.subject });
  }

  // One message per subscriber, so no one sees the list and each footer unsubscribes only its reader.
  // The team already has its copy.
  const teamSet = new Set(team.map((a) => a.toLowerCase()));
  const subscribers = (opts.subscribers ?? []).filter((s) => !teamSet.has(s.email));
  if (subscribers.length > 0) {
    if (mail) {
      let sentCount = 0;
      for (const s of subscribers) {
        try {
          await mail.send({ to: [s.email], ...buildDigestEmail(report, unsubscribeUrl(s.token)) });
          sentCount++;
        } catch (err) {
          log.error("digest subscriber email failed", { error: errorMessage(err) });
        }
      }
      log.info("digest sent to subscribers", { sent: sentCount, of: subscribers.length });
      if (sentCount > 0) delivered.push("subscribers");
    } else {
      log.info("digest subscriber dry run: AgentMail not set", { subscribers: subscribers.length });
    }
  }

  if (config.SLACK_WEBHOOK_URL) {
    try {
      const res = await fetchImpl(config.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildDigestSlack(report)),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Slack HTTP ${res.status}: ${await res.text()}`);
      delivered.push("slack");
    } catch (err) {
      log.error("digest slack post failed", { error: errorMessage(err) });
    }
  } else {
    log.info("digest slack dry run: SLACK_WEBHOOK_URL not set");
  }
  return delivered;
}
