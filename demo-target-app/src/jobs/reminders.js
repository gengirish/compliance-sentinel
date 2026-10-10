const db = require("../lib/db");
const { sendMail } = require("../lib/mailer");

async function sendAppointmentReminders() {
  const { rows } = await db.query(
    "SELECT a.id, u.email, a.starts_at FROM appointments a JOIN users u ON u.id = a.user_id WHERE a.starts_at < now() + interval '24 hours' AND a.reminded = false",
  );
  for (const row of rows) {
    await sendMail({ to: row.email, subject: "Appointment reminder", body: `See you at ${row.starts_at}` });
    await db.query("UPDATE appointments SET reminded = true WHERE id = $1", [row.id]);
  }
}

module.exports = { sendAppointmentReminders };
