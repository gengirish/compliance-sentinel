const { Pool } = require("pg");
const config = require("../config");

const pool = new Pool({
  host: config.db.host,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  ssl: { rejectUnauthorized: true },
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
