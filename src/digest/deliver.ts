import { config } from "../config.js";
import { errorMessage, log } from "../log.js";
import { AgentMailClient } from "../notify/agentmail.js";
import type { RuleDigestRecord } from "./digestRule.js";
import { emailColors, escapeHtml, renderEmail } from "./emailLayout.js";
import { unsubscribeUrl, type Subscriber } from "./subscribers.js";

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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2027-03-31" as "31 March 2027"; anything that is not an ISO date is returned as written. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m && MONTHS[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

/** "19 – 26 October 2026","28 September – 5 October 2026", or with both years when they differ. */
export function formatPeriod(from: string, to: string): string {
  const parse = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return { y: y!, m: m!, d: d! };
  };
  const a = parse(from);
  const b = parse(to);
  if ([a.y, a.m, a.d, b.y, b.m, b.d].some((n) => !Number.isFinite(n))) return `${from} – ${to}`;
  const end = `${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.y !== b.y) return `${a.d} ${MONTHS[a.m - 1]} ${a.y} – ${end}`;
  if (a.m !== b.m) return `${a.d} ${MONTHS[a.m - 1]} – ${end}`;
  return `${a.d} – ${end}`;
}

/** Source keys are short regulator slugs (fca, sec, esma); show them as acronyms. */
function sourceLabel(source: string): string {
  return source.length <= 6 ? source.toUpperCase() : source;
}

function kindBadge(kind: RuleDigestRecord["kind"]): string {
  const c = emailColors;
  const [bg, ink, label] = kind === "amended" ? [c.amendedBg, c.amendedInk, "Amended"] : [c.newBg, c.newInk, "New"];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${ink};font-size:11px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase">${label}</span>`;
}

function statCell(value: number, label: string): string {
  const c = emailColors;
  return `<td width="33%" align="center" style="padding:14px 8px;border:1px solid ${c.border};border-radius:6px;background:#f9fafb"><div style="font-size:24px;font-weight:700;line-height:1.2;color:${c.ink}">${value}</div><div style="font-size:12px;color:${c.muted}">${label}</div></td>`;
}

function ruleCard(r: RuleDigestRecord): string {
  const c = emailColors;
  const date = r.digest.effective_date ?? r.effectiveDate;
  const effective = date ? formatDate(date) : "Not stated";
  const detail = (label: string, value: string) =>
    `<tr><td valign="top" width="120" style="padding:6px 12px 6px 0;font-size:13px;font-weight:600;color:${c.ink}">${label}</td><td valign="top" style="padding:6px 0;font-size:14px;color:${c.body}">${escapeHtml(value)}</td></tr>`;
  const duties = r.digest.key_obligations.length
    ? `<p style="margin:16px 0 6px;font-size:13px;font-weight:600;color:${c.ink}">Key obligations</p>
<ul style="margin:0;padding-left:20px">${r.digest.key_obligations.map((d) => `<li style="margin:0 0 4px">${escapeHtml(d)}</li>`).join("")}</ul>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border:1px solid ${c.border};border-left:4px solid ${r.kind === "amended" ? c.amendedInk : c.newInk};border-radius:6px">
<tr><td style="padding:18px 20px">
<p style="margin:0 0 8px">${kindBadge(r.kind)} <span style="font-size:12px;color:${c.muted}">&nbsp;Effective ${escapeHtml(effective)}</span></p>
<h3 style="margin:0 0 10px;font-size:17px;line-height:1.35;font-weight:700"><a href="${escapeHtml(r.url)}" style="color:${c.ink};text-decoration:none">${escapeHtml(r.title)}</a></h3>
<p style="margin:0 0 12px">${escapeHtml(r.digest.summary)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${c.border}">
${detail("What changed", r.digest.what_changed)}
${detail("Applies to", r.digest.applies_to)}
</table>
${duties}
<p style="margin:16px 0 0;font-size:14px"><a href="${escapeHtml(r.url)}" style="color:${c.accent};font-weight:600;text-decoration:none">Read the full rule &rarr;</a></p>
</td></tr>
</table>`;
}

/** The email body; with `unsubscribe`, a footer linking to that subscriber's unsubscribe page. */
export function buildDigestEmail(report: DigestReport, unsubscribe?: string): { subject: string; html: string; text: string } {
  const c = emailColors;
  const subject = `[Compliance Sentinel] ${digestHeadline(report)}`;
  const n = report.records.length;
  const amended = report.records.filter((r) => r.kind === "amended").length;
  const groups = bySource(report.records);
  const period = formatPeriod(report.from, report.to);

  const sections: string[] = [];
  if (n === 0) {
    sections.push(
      `<p style="margin:0 0 8px;font-size:16px;font-weight:600;color:${c.ink}">No changes this week</p>`,
      `<p style="margin:0">None of the rules we track was added or amended over the period ${escapeHtml(period)}. We will keep monitoring and let you know as soon as something changes.</p>`,
    );
  } else {
    sections.push(
      `<p style="margin:0 0 20px">Here is your summary of the regulatory rules that were added or amended over the period ${escapeHtml(period)}, across ${groups.size} regulator${groups.size === 1 ? "" : "s"}.</p>`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" border="0" style="margin:0 0 12px"><tr>${statCell(n, `Rule change${n === 1 ? "" : "s"}`)}${statCell(n - amended, "New")}${statCell(amended, "Amended")}</tr></table>`,
    );
    for (const [source, records] of groups) {
      sections.push(
        `<h2 style="margin:28px 0 12px;padding-bottom:8px;border-bottom:2px solid ${c.ink};font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${c.ink}">${escapeHtml(sourceLabel(source))} <span style="font-weight:400;color:${c.muted}">&middot; ${records.length} change${records.length === 1 ? "" : "s"}</span></h2>`,
        ...records.map(ruleCard),
      );
    }
  }

  const footer = ["This digest is an automated summary of published rule text and does not constitute legal advice. Always refer to the official source."];
  if (unsubscribe) {
    footer.push(`You are receiving this email because you subscribed to the Compliance Sentinel weekly digest. <a href="${escapeHtml(unsubscribe)}" style="color:${c.muted};text-decoration:underline">Unsubscribe</a>`);
  }
  const html = renderEmail({
    preheader: n === 0 ? `No tracked rule changed over ${period}.` : `${n} rule change${n === 1 ? "" : "s"} (${n - amended} new, ${amended} amended), ${period}.`,
    title: "Weekly regulatory digest",
    subtitle: period,
    body: sections.join("\n"),
    footer,
  });
  const text = unsubscribe ? `${buildDigestMarkdown(report)}\n\nUnsubscribe: ${unsubscribe}` : buildDigestMarkdown(report);
  return { subject, html, text };
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
