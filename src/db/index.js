const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  family: 4, // Force IPv4 — Railway's network doesn't route IPv6 to Supabase
});

pool.on('error', (err) => {
  console.error('Unexpected DB client error', err);
});

const query = (text, params) => pool.query(text, params);

module.exports = { query, pool };
