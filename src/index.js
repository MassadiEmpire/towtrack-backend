// Force IPv4 DNS resolution globally — Railway's network doesn't route IPv6 to Supabase
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes    = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const towRoutes     = require('./routes/tow');
const db            = require('./db');
const { runDispatch } = require('./agents/dispatch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'towtrack-api' }));

// DB connectivity check
app.get('/health/db', async (req, res) => {
  try {
    const result = await db.query('SELECT COUNT(*) AS users FROM users');
    res.json({ status: 'ok', users: result.rows[0].users });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, code: err.code });
  }
});

// Routes
app.use('/auth', authRoutes);
app.use('/profile', profileRoutes);
app.use('/tow-requests', towRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`TowTrack API running on port ${PORT}`);

  // Run dispatch agent every 30 seconds when ANTHROPIC_API_KEY is set
  if (process.env.ANTHROPIC_API_KEY) {
    setInterval(() => runDispatch(db), 30000);
    console.log('Dispatch agent active (30s cycle)');
  }
});
