const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /profile/me — get current user profile
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, email, phone, role, avatar_url, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    let driverProfile = null;
    if (user.role === 'driver') {
      const dp = await db.query(
        'SELECT * FROM driver_profiles WHERE user_id = $1',
        [user.id]
      );
      driverProfile = dp.rows[0] || null;
    }

    return res.json({ user, driverProfile });
  } catch (err) {
    console.error('Profile fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /profile/me — update user info
router.patch(
  '/me',
  authenticate,
  [
    body('name').optional().trim().notEmpty(),
    body('phone').optional().trim().notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, phone } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;

    if (name) { fields.push(`name = $${idx++}`); values.push(name); }
    if (phone) { fields.push(`phone = $${idx++}`); values.push(phone); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    fields.push(`updated_at = NOW()`);
    values.push(req.user.id);

    try {
      const result = await db.query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, name, email, phone, role`,
        values
      );
      return res.json({ user: result.rows[0] });
    } catch (err) {
      console.error('Profile update error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /profile/driver — update driver vehicle info
router.patch(
  '/driver',
  authenticate,
  async (req, res) => {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Drivers only' });
    }

    const { vehicleMake, vehicleModel, vehicleYear, licensePlate, truckType, isAvailable } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;

    if (vehicleMake)   { fields.push(`vehicle_make = $${idx++}`); values.push(vehicleMake); }
    if (vehicleModel)  { fields.push(`vehicle_model = $${idx++}`); values.push(vehicleModel); }
    if (vehicleYear)   { fields.push(`vehicle_year = $${idx++}`); values.push(vehicleYear); }
    if (licensePlate)  { fields.push(`license_plate = $${idx++}`); values.push(licensePlate); }
    if (truckType)     { fields.push(`truck_type = $${idx++}`); values.push(truckType); }
    if (isAvailable !== undefined) { fields.push(`is_available = $${idx++}`); values.push(isAvailable); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    fields.push(`updated_at = NOW()`);

    try {
      const dp = await db.query(
        'SELECT id FROM driver_profiles WHERE user_id = $1',
        [req.user.id]
      );
      if (!dp.rows[0]) return res.status(404).json({ error: 'Driver profile not found' });

      values.push(dp.rows[0].id);
      const result = await db.query(
        `UPDATE driver_profiles SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );
      return res.json({ driverProfile: result.rows[0] });
    } catch (err) {
      console.error('Driver profile update error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PUT /profile/push-token — save device push token
router.put('/push-token', authenticate, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  try {
    await db.query('UPDATE users SET push_token = $1 WHERE id = $2', [token, req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Push token save error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /profile/driver/location — driver updates their live GPS position
router.put('/driver/location', authenticate, async (req, res) => {
  if (req.user.role !== 'driver') {
    return res.status(403).json({ error: 'Drivers only' });
  }

  const { lat, lng, heading } = req.body;
  if (lat == null || lng == null) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  try {
    const dp = await db.query(
      'SELECT id FROM driver_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (!dp.rows[0]) return res.status(404).json({ error: 'Driver profile not found' });
    const driverId = dp.rows[0].id;

    await db.query(
      `INSERT INTO driver_locations (driver_id, location, heading, updated_at)
       VALUES ($1, ST_MakePoint($2, $3)::geography, $4, NOW())
       ON CONFLICT (driver_id) DO UPDATE
       SET location = ST_MakePoint($2, $3)::geography,
           heading  = $4,
           updated_at = NOW()`,
      [driverId, lng, lat, heading ?? null]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Update driver location error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
