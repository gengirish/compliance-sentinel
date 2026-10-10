const jwt = require("jsonwebtoken");
const config = require("../config");

// Authentication: verifies the bearer token on every protected route.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "authentication required" });
  }
  try {
    req.user = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    return next();
  } catch (err) {
    return res.status(401).json({ error: "invalid token" });
  }
}

// Authorization: role-based access control, least privilege by default.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
