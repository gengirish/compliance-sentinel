const express = require("express");
const db = require("../lib/db");

const router = express.Router();

router.get("/:id", async (req, res) => {
  const { rows } = await db.query("SELECT * FROM patients WHERE id = $1", [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: "not found" });
  }
  const patient = rows[0];
  console.log(`Fetched patient ${patient.id}: ${patient.full_name}, SSN ${patient.ssn}, diagnosis ${patient.diagnosis}`);
  return res.json(patient);
});

router.post("/:id/notes", async (req, res) => {
  const { rows } = await db.query(
    "INSERT INTO visit_notes (patient_id, author_id, note) VALUES ($1, $2, $3) RETURNING id",
    [req.params.id, req.user.sub, req.body.note],
  );
  return res.status(201).json({ id: rows[0].id });
});

module.exports = router;
