const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const authRoutes    = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const dealsRoutes   = require('./routes/deals');
const paymentRoutes = require('./routes/payments');
const db            = require('./db');
const { runMigrations } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use('/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'settld-api' }));

app.get('/health/db', async (req, res) => {
  try {
    const result = await db.query('SELECT COUNT(*) AS users FROM users');
    res.json({ status: 'ok', users: result.rows[0].users });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.use('/auth',     authRoutes);
app.use('/profile',  profileRoutes);
app.use('/deals',    dealsRoutes);
app.use('/payments', paymentRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, async () => {
  console.log(`Settld API running on port ${PORT}`);
  await runMigrations().catch((e) => console.error('Migration startup error:', e.message));
});
