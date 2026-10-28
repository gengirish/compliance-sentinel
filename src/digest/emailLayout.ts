import { config } from "../config.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The shared shell for every Compliance Sentinel email: table-based with inline
 * styles so it renders the same in Gmail, Outlook and Apple Mail.
 */
export const emailColors = {
  ink: "#111827",
  body: "#374151",
  muted: "#6b7280",
  border: "#e5e7eb",
  canvas: "#f3f4f6",
  card: "#ffffff",
  brand: "#1e3a5f",
  accent: "#2563eb",
  newBg: "#ecfdf5",
  newInk: "#047857",
  amendedBg: "#fffbeb",
  amendedInk: "#b45309",
} as const;

export const fontStack = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type EmailLayout = {
  /** Shown in the inbox list after the subject; never rendered in the body. */
  preheader: string;
  /** The heading in the brand bar. */
  title: string;
  /** A line under the title, such as the period covered. */
  subtitle?: string;
  /** Already-rendered HTML for the body of the card. */
  body: string;
  /** Already-rendered HTML lines for the footer, under the brand line. */
  footer?: string[];
};

/** A bulletproof button: a padded table cell, so Outlook keeps its colour and size. */
export function emailButton(href: string, label: string): string {
  const c = emailColors;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:6px;background:${c.accent}"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;font-family:${fontStack};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(label)}</a></td></tr></table>`;
}

export function renderEmail(layout: EmailLayout): string {
  const c = emailColors;
  const footer = [
    `<a href="${escapeHtml(config.DASHBOARD_URL)}" style="color:${c.muted};text-decoration:underline">Compliance Sentinel</a> &middot; regulatory change monitoring`,
    ...(layout.footer ?? []),
  ]
    .map((line) => `<p style="margin:0 0 6px">${line}</p>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(layout.title)}</title>
</head>
<body style="margin:0;padding:0;background:${c.canvas}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(layout.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.canvas}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;border-collapse:separate">
<tr><td style="background:${c.brand};border-radius:8px 8px 0 0;padding:24px 28px;font-family:${fontStack}">
<p style="margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#bfdbfe">Compliance Sentinel</p>
<h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:700;color:#ffffff">${escapeHtml(layout.title)}</h1>
${layout.subtitle ? `<p style="margin:6px 0 0;font-size:14px;color:#dbeafe">${escapeHtml(layout.subtitle)}</p>` : ""}
</td></tr>
<tr><td style="background:${c.card};border:1px solid ${c.border};border-top:0;border-radius:0 0 8px 8px;padding:28px;font-family:${fontStack};font-size:15px;line-height:1.6;color:${c.body}">
${layout.body}
</td></tr>
<tr><td style="padding:20px 28px;font-family:${fontStack};font-size:12px;line-height:1.5;color:${c.muted};text-align:center">
${footer}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
