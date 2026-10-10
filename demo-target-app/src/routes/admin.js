const express = require("express");
const db = require("../lib/db");

const router = express.Router();

// Staff directory. Mounted behind requireAuth + requireRole("admin") in server.js.
router.get("/users", async (req, res) => {
  const { rows } = await db.query("SELECT id, email, role, created_at FROM users ORDER BY id");
  res.json(rows);
});

router.patch("/users/:id/role", async (req, res) => {
  await db.query("UPDATE users SET role = $1 WHERE id = $2", [req.body.role, req.params.id]);
  res.status(204).end();
});

module.exports = router;
