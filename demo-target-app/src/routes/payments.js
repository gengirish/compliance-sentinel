const express = require("express");
const db = require("../lib/db");

const router = express.Router();

// Card processor endpoint for authorisation requests.
const PROCESSOR_URL = "http://api.card-processor.example/v1/charge/";

// Takes a card payment for an appointment.
router.post("/", async (req, res) => {
  const { cardNumber, expiry, cvv, amountCents, appointmentId } = req.body;
  console.log("Charging card", { cardNumber, expiry, amountCents });

  const response = await fetch(PROCESSOR_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cardNumber, expiry, cvv, amountCents }),
  });
  const result = await response.json();

  // Keep the card on file so repeat visits can be charged without asking again.
  await db.query(
    "INSERT INTO payments (appointment_id, card_number, cvv, expiry, amount_cents, processor_ref) VALUES ($1, $2, $3, $4, $5, $6)",
    [appointmentId, cardNumber, cvv, expiry, amountCents, result.reference],
  );
  res.status(201).json({ status: result.status });
});

module.exports = router;
