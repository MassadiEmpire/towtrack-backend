const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  family: 4,
});

pool.on('error', (err) => {
  console.error('Unexpected DB client error', err);
});

const query = (text, params) => pool.query(text, params);

async function runMigrations() {
  const migrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token VARCHAR(255)`,
    `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,

    `CREATE TABLE IF NOT EXISTS deals (
       id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
       owner_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       address          TEXT NOT NULL,
       suburb           TEXT,
       deal_type        VARCHAR(20) NOT NULL DEFAULT 'purchase',
       status           VARCHAR(20) NOT NULL DEFAULT 'active',
       settlement_date  DATE,
       price            TEXT,
       created_at       TIMESTAMPTZ DEFAULT NOW(),
       updated_at       TIMESTAMPTZ DEFAULT NOW()
     )`,

    `CREATE TABLE IF NOT EXISTS deal_parties (
       id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
       deal_id    UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
       user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
       name       TEXT NOT NULL,
       email      TEXT,
       phone      TEXT,
       role       VARCHAR(50) NOT NULL,
       status     VARCHAR(20) DEFAULT 'invited',
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`,

    `CREATE TABLE IF NOT EXISTS deal_messages (
       id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
       deal_id     UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
       sender_id   UUID REFERENCES users(id) ON DELETE SET NULL,
       sender_name TEXT,
       sender_role TEXT,
       channel     VARCHAR(20) NOT NULL DEFAULT 'in_app',
       content     TEXT NOT NULL,
       is_ai       BOOLEAN DEFAULT FALSE,
       created_at  TIMESTAMPTZ DEFAULT NOW()
     )`,

    `CREATE TABLE IF NOT EXISTS deal_tasks (
       id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
       deal_id       UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
       title         TEXT NOT NULL,
       assignee_name TEXT,
       assignee_role TEXT,
       due_date      DATE,
       priority      VARCHAR(10) DEFAULT 'medium',
       done          BOOLEAN DEFAULT FALSE,
       ai_generated  BOOLEAN DEFAULT FALSE,
       created_at    TIMESTAMPTZ DEFAULT NOW(),
       updated_at    TIMESTAMPTZ DEFAULT NOW()
     )`,

    `CREATE TABLE IF NOT EXISTS deal_documents (
       id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
       deal_id       UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
       name          TEXT NOT NULL,
       storage_url   TEXT,
       file_size     TEXT,
       sign_status   VARCHAR(30) DEFAULT 'uploaded',
       uploaded_by   TEXT,
       created_at    TIMESTAMPTZ DEFAULT NOW()
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
