// Transport security: every request must arrive over TLS.
function enforceHttps(req, res, next) {
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    return next();
  }
  return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
}

module.exports = { enforceHttps };
