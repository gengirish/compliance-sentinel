const config = require("../config");

async function sendMail({ to, subject, body }) {
  const res = await fetch("https://api.mailer.example/v1/send", {
    method: "POST",
    headers: { authorization: `Bearer ${config.mailer.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: config.mailer.from, to, subject, body }),
  });
  return res.ok;
}

module.exports = { sendMail };
