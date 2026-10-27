const express = require("express");
const helmet = require("helmet");
const config = require("./config");
const { enforceHttps } = require("./middleware/https");
const { requireAuth, requireRole } = require("./middleware/auth");
const { registerJobs } = require("./jobs");

const app = express();

app.set("trust proxy", 1);
app.use(enforceHttps);
app.use(
  helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }),
);
app.use(express.json());

app.use("/signup", require("./routes/signup"));
app.use("/patients", requireAuth, require("./routes/patients"));
app.use("/payments", requireAuth, require("./routes/payments"));
app.use("/admin", requireAuth, requireRole("admin"), require("./routes/admin"));
app.use("/incidents", requireAuth, requireRole("admin"), require("./routes/incidents"));

registerJobs();

app.listen(config.port, () => {
  console.log(`patient portal listening on ${config.port}`);
});
