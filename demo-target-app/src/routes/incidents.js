const express = require("express");
const db = require("../lib/db");

const router = express.Router();

// Security incident intake used by the on-call engineer.
router.post("/", async (req, res) => {
  const { summary, affectedRecords, detectedAt } = req.body;

  const { rows } = await db.query(
    "INSERT INTO security_incidents (summary, affected_records, detected_at) VALUES ($1, $2, $3) RETURNING id",
    [summary, affectedRecords, detectedAt],
  );

  // TODO: tell someone about this
  console.log("incident recorded", rows[0].id);

  res.status(201).json({ id: rows[0].id });
});

module.exports = router;
