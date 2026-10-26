// Registers the AgentMail webhook that delivers mail sent to the app's inbox
// to POST <public-url>/inbox/agentmail, and prints the signing secret to set.
//
//   AGENTMAIL_API_KEY=... AGENTMAIL_INBOX_ID=alerts@example.com \
//   node scripts/agentmail-webhook.mjs https://compliance-sentinel-gengirish.fly.dev
import "dotenv/config";

const base = process.argv[2]?.replace(/\/+$/, "");
const apiKey = process.env.AGENTMAIL_API_KEY;
const inboxId = process.env.AGENTMAIL_INBOX_ID;
const apiUrl = (process.env.AGENTMAIL_API_URL ?? "https://api.agentmail.to/v0").replace(/\/+$/, "");

if (!base || !apiKey || !inboxId) {
  console.error("usage: AGENTMAIL_API_KEY=... AGENTMAIL_INBOX_ID=... node scripts/agentmail-webhook.mjs <public base url>");
  process.exit(2);
}

const res = await fetch(`${apiUrl}/webhooks`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    url: `${base}/inbox/agentmail`,
    event_types: ["message.received"],
    inbox_ids: [inboxId],
    client_id: `compliance-sentinel-inbound:${new URL(base).host}`,
  }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`AgentMail HTTP ${res.status}:`, JSON.stringify(body));
  process.exit(1);
}
console.log(`Webhook ${body.webhook_id} -> ${body.url}`);
console.log("Set the signing secret where the web process runs, for example:");
console.log(`  fly secrets set AGENTMAIL_WEBHOOK_SECRET='${body.secret}'`);
