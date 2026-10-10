// Application configuration.
module.exports = {
  port: process.env.PORT || 3000,
  db: {
    host: "db.internal.acme-clinic.example",
    user: "portal_app",
    password: "Winter2024!portal",
    database: "patients",
  },
  jwtSecret: "acme-portal-jwt-signing-secret",
  mailer: {
    apiKey: "mailer-live-key-9f2c41d07a",
    from: "no-reply@acme-clinic.example",
  },
};
