const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendPush, getPushToken } = require('../utils/notifications');

const router = express.Router();

// Notification messages per status
const PUSH_MESSAGES = {
  accepted:    { title: 'Driver Found! 🚛',    body: 'A driver accepted your request and is heading your way.' },
  en_route:    { title: 'Driver En Route 🚛',  body: 'Your driver is on the way to your location.' },
  arrived:     { title: 'Driver Arrived 📍',   body: 'Your driver has arrived at your pickup location!' },
  in_progress: { title: 'Tow Started ⛓️',      body: 'Your vehicle is now being towed.' },
  completed:   { title: 'All Done! ✅',         body: 'Your tow is complete. Thank you for using TowTrack.' },
  cancelled:   { title: 'Request Cancelled',   body: 'Your tow request has been cancelled.' },
};

// POST /tow-requests — customer creates a tow request
router.post(
  '/',
  authenticate,
  requireRole('customer'),
  [body('pickupAddress').trim().notEmpty().withMessage('Pickup address is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { pickupAddress, vehicleInfo, notes, pickupLat, pickupLng, destAddress, destLat, destLng } = req.body;

    try {
      const active = await db.query(
        `SELECT id FROM tow_requests
         WHERE customer_id = $1 AND status NOT IN ('completed', 'cancelled')`,
        [req.user.id]
      );
      if (active.rows.length > 0) {
        return res.status(409).json({ error: 'You already have an active tow request' });
      }

      const result = await db.query(
        `INSERT INTO tow_requests
           (customer_id, pickup_address, pickup_lat, pickup_lng,
            dest_address, dest_lat, dest_lng, vehicle_info, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          req.user.id,
          pickupAddress,
          pickupLat   || 0,
          pickupLng   || 0,
          destAddress || null,
          destLat     || null,
          destLng     || null,
          vehicleInfo || null,
          notes       || null,
        ]
      );
      return res.status(201).json({ request: result.rows[0] });
    } catch (err) {
      console.error('Create tow request error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /tow-requests/active — customer: their current active request
router.get('/active', authenticate, requireRole('customer'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT tr.*,
              u.name  AS driver_name,
              u.phone AS driver_phone,
              dp.vehicle_make,
              dp.vehicle_model,
              dp.rating AS driver_rating,
              ST_Y(dl.location::geometry) AS driver_lat,
              ST_X(dl.location::geometry) AS driver_lng
       FROM tow_requests tr
       LEFT JOIN driver_profiles dp ON dp.id = tr.driver_id
       LEFT JOIN users u            ON u.id  = dp.user_id
       LEFT JOIN driver_locations dl ON dl.driver_id = dp.id
       WHERE tr.customer_id = $1
         AND tr.status NOT IN ('completed', 'cancelled')
       ORDER BY tr.created_at DESC
       LIMIT 1`,
      [req.user.id]
    );
    return res.json({ request: result.rows[0] || null });
  } catch (err) {
    console.error('Get active request error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /tow-requests/earnings — driver: earnings summary + transaction history
router.get('/earnings', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const dp = await db.query('SELECT id FROM driver_profiles WHERE user_id = $1', [req.user.id]);
    if (!dp.rows[0]) return res.status(404).json({ error: 'Driver profile not found' });
    const driverId = dp.rows[0].id;

    const summary = await db.query(
      `SELECT
         COUNT(*)                                                         AS total_jobs,
         COALESCE(SUM(final_price), 0)                                   AS total_earned,
         COALESCE(SUM(CASE WHEN completed_at >= NOW() - INTERVAL '7 days'
                           THEN final_price END), 0)                     AS week_earned,
         COALESCE(SUM(CASE WHEN completed_at >= NOW() - INTERVAL '30 days'
                           THEN final_price END), 0)                     AS month_earned
       FROM tow_requests
       WHERE driver_id = $1 AND status = 'completed'`,
      [driverId]
    );

    const transactions = await db.query(
      `SELECT tr.id, tr.pickup_address, tr.final_price, tr.completed_at,
              u.name AS customer_name
       FROM tow_requests tr
       JOIN users u ON u.id = tr.customer_id
       WHERE tr.driver_id = $1 AND tr.status = 'completed'
       ORDER BY tr.completed_at DESC
       LIMIT 20`,
      [driverId]
    );

    return res.json({ summary: summary.rows[0], transactions: transactions.rows });
  } catch (err) {
    console.error('Earnings error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /tow-requests — customer: full history; driver: pending + their active job
router.get('/', authenticate, async (req, res) => {
  try {
    let result;

    if (req.user.role === 'customer') {
      result = await db.query(
        `SELECT tr.*,
                u.name  AS driver_name,
                u.phone AS driver_phone,
                dp.rating AS driver_rating
         FROM tow_requests tr
         LEFT JOIN driver_profiles dp ON dp.id = tr.driver_id
         LEFT JOIN users u            ON u.id  = dp.user_id
         WHERE tr.customer_id = $1
         ORDER BY tr.created_at DESC`,
        [req.user.id]
      );
    } else {
      const dp = await db.query('SELECT id FROM driver_profiles WHERE user_id = $1', [req.user.id]);
      if (!dp.rows[0]) return res.status(404).json({ error: 'Driver profile not found' });
      const driverId = dp.rows[0].id;

      result = await db.query(
        `SELECT tr.*,
                u.name  AS customer_name,
                u.phone AS customer_phone
         FROM tow_requests tr
         JOIN users u ON u.id = tr.customer_id
         WHERE (tr.status = 'pending')
            OR (tr.driver_id = $1 AND tr.status NOT IN ('completed', 'cancelled'))
         ORDER BY tr.created_at DESC`,
        [driverId]
      );
    }

    return res.json({ requests: result.rows });
  } catch (err) {
    console.error('Get tow requests error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /tow-requests/:id/status — update status
router.patch('/:id/status', authenticate, async (req, res) => {
  const { id }                  = req.params;
  const { status, finalPrice }  = req.body;

  const validStatuses = ['accepted', 'en_route', 'arrived', 'in_progress', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const reqResult = await db.query('SELECT * FROM tow_requests WHERE id = $1', [id]);
    const towRequest = reqResult.rows[0];
    if (!towRequest) return res.status(404).json({ error: 'Request not found' });

    if (req.user.role === 'customer') {
      if (towRequest.customer_id !== req.user.id) {
        return res.status(403).json({ error: 'Not your request' });
      }
      if (status !== 'cancelled') {
        return res.status(403).json({ error: 'Customers can only cancel requests' });
      }
    }

    if (req.user.role === 'driver') {
      const dp = await db.query('SELECT id FROM driver_profiles WHERE user_id = $1', [req.user.id]);
      if (!dp.rows[0]) return res.status(404).json({ error: 'Driver profile not found' });
      const driverId = dp.rows[0].id;

      if (status === 'accepted' && towRequest.status === 'pending') {
        const update = await db.query(
          `UPDATE tow_requests
           SET status = 'accepted', driver_id = $1, accepted_at = NOW()
           WHERE id = $2 AND status = 'pending'
           RETURNING *`,
          [driverId, id]
        );
        if (update.rows.length === 0) {
          return res.status(409).json({ error: 'Request was already accepted by another driver' });
        }
        // Notify customer their request was accepted
        const customerToken = await getPushToken(db, towRequest.customer_id);
        const msg = PUSH_MESSAGES.accepted;
        sendPush(customerToken, msg.title, msg.body, { requestId: id, status: 'accepted' });
        return res.json({ request: update.rows[0] });
      }

      if (towRequest.driver_id !== driverId) {
        return res.status(403).json({ error: 'Not your job' });
      }
    }

    let extraFields = status === 'completed' ? ', completed_at = NOW()' : '';
    const params = [status, id];
    if (status === 'completed' && finalPrice != null) {
      extraFields += `, final_price = $${params.length + 1}`;
      params.push(parseFloat(finalPrice));
    }
    const result = await db.query(
      `UPDATE tow_requests SET status = $1${extraFields} WHERE id = $2 RETURNING *`,
      params
    );

    if (status === 'completed' && result.rows[0].driver_id) {
      await db.query(
        'UPDATE driver_profiles SET total_jobs = total_jobs + 1 WHERE id = $1',
        [result.rows[0].driver_id]
      );
    }

    // Push notification to customer on every driver status change
    if (req.user.role === 'driver' && PUSH_MESSAGES[status]) {
      const customerToken = await getPushToken(db, result.rows[0].customer_id);
      const msg = PUSH_MESSAGES[status];
      sendPush(customerToken, msg.title, msg.body, { requestId: id, status });
    }

    return res.json({ request: result.rows[0] });
  } catch (err) {
    console.error('Update status error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
