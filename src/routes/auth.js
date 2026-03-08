const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const signToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

// POST /auth/signup
router.post(
  '/signup',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be 6+ characters'),
    body('role').isIn(['customer', 'driver']).withMessage('Role must be customer or driver'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, phone, password, role, vehicleMake, vehicleModel, vehicleYear, licensePlate, truckType } = req.body;

    try {
      // Check if email already exists
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      // Insert user
      const userResult = await db.query(
        `INSERT INTO users (name, email, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, phone, role, created_at`,
        [name, email, phone, passwordHash, role]
      );
      const user = userResult.rows[0];

      // If driver, create driver profile
      if (role === 'driver') {
        if (!vehicleMake || !vehicleModel || !vehicleYear || !licensePlate) {
          // Rollback user creation
          await db.query('DELETE FROM users WHERE id = $1', [user.id]);
          return res.status(400).json({ error: 'Vehicle info required for drivers' });
        }
        await db.query(
          `INSERT INTO driver_profiles (user_id, vehicle_make, vehicle_model, vehicle_year, license_plate, truck_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [user.id, vehicleMake, vehicleModel, vehicleYear, licensePlate, truckType || 'flatbed']
        );
      }

      const token = signToken(user);
      return res.status(201).json({ token, user });
    } catch (err) {
      console.error('Signup error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /auth/login
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const result = await db.query(
        'SELECT id, name, email, phone, role, password_hash FROM users WHERE email = $1',
        [email]
      );
      const user = result.rows[0];

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const { password_hash, ...safeUser } = user;
      const token = signToken(safeUser);

      // If driver, attach driver profile
      let driverProfile = null;
      if (user.role === 'driver') {
        const dp = await db.query(
          'SELECT * FROM driver_profiles WHERE user_id = $1',
          [user.id]
        );
        driverProfile = dp.rows[0] || null;
      }

      return res.json({ token, user: safeUser, driverProfile });
    } catch (err) {
      console.error('Login error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /auth/change-password
router.patch(
  '/change-password',
  authenticate,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be 6+ characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { currentPassword, newPassword } = req.body;
    try {
      const result = await db.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [req.user.id]
      );
      const user = result.rows[0];
      if (!user) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

      const newHash = await bcrypt.hash(newPassword, 12);
      await db.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [newHash, req.user.id]
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('Change password error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
