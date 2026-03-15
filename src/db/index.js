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

/**
 * Safely add columns / tables that may be missing from older DB deployments.
 * Uses IF NOT EXISTS / DO NOTHING so it's safe to run on every startup.
 */
async function runMigrations() {
  const migrations = [
    // Payment columns on tow_requests (missing from original schema)
    `ALTER TABLE tow_requests
       ADD COLUMN IF NOT EXISTS payment_status    VARCHAR(20) DEFAULT 'unpaid',
       ADD COLUMN IF NOT EXISTS payment_intent_id VARCHAR(255)`,

    // Ensure reviews table exists (was in schema but may not have been applied)
    `CREATE TABLE IF NOT EXISTS reviews (
       id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
       request_id  UUID NOT NULL REFERENCES tow_requests(id),
       reviewer_id UUID NOT NULL REFERENCES users(id),
       driver_id   UUID NOT NULL REFERENCES driver_profiles(id),
       reviewer_role VARCHAR(10) NOT NULL DEFAULT 'customer',
       rating      INTEGER CHECK (rating BETWEEN 1 AND 5),
       comment     TEXT,
       created_at  TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE (request_id, reviewer_role)
     )`,
  ];

  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error('Migration error (non-fatal):', err.message);
    }
  }
  console.log('DB migrations applied');
}

module.exports = { query, pool, runMigrations };
