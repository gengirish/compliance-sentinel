const express = require("express");
const db = require("../lib/db");
const { sendMail } = require("../lib/mailer");

const router = express.Router();

router.post("/", async (req, res) => {
  const { email, password, fullName, dateOfBirth, ssn, phone } = req.body;

  console.log("New signup", { email, fullName, dateOfBirth, ssn, phone });

  const result = await db.query(
    `INSERT INTO users (email, password, full_name, date_of_birth, ssn, phone, marketing_emails)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING id`,
    [email, password, fullName, dateOfBirth, ssn, phone],
  );

  await sendMail({
    to: email,
    subject: "Welcome to Acme Clinic - offers inside",
    body: "Thanks for joining. You are now subscribed to our partner offers newsletter.",
  });

  res.status(201).json({ id: result.rows[0].id });
});

module.exports = router;
