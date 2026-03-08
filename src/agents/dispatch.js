/**
 * TowTrack Dispatch Agent
 *
 * Uses Claude to intelligently match pending tow requests with the nearest
 * available drivers, send push notifications, and log dispatch decisions.
 *
 * Usage:
 *   const { runDispatch } = require('./dispatch');
 *   await runDispatch(db);
 */

const { runAgent }    = require('./agent');
const { sendPush, getPushToken } = require('../utils/notifications');

// ── Tool definitions for Claude ──────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_pending_requests',
    description: 'Fetch all tow requests that are still pending (no driver assigned yet).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_available_drivers',
    description: 'Fetch all online drivers with their current GPS location.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'notify_driver',
    description: 'Send a push notification to a specific driver about a pending job.',
    input_schema: {
      type: 'object',
      properties: {
        driver_user_id: { type: 'string', description: 'The user ID of the driver to notify' },
        request_id:     { type: 'string', description: 'The tow request ID' },
        pickup_address: { type: 'string', description: 'The pickup address for context' },
        distance_km:    { type: 'number', description: 'Estimated distance to pickup in km' },
      },
      required: ['driver_user_id', 'request_id', 'pickup_address'],
    },
  },
  {
    name: 'log_dispatch_decision',
    description: 'Log which drivers were notified for a given request (for audit trail).',
    input_schema: {
      type: 'object',
      properties: {
        request_id:      { type: 'string' },
        notified_drivers: { type: 'array', items: { type: 'string' }, description: 'Array of driver user IDs notified' },
        reasoning:       { type: 'string', description: 'Brief explanation of dispatch logic' },
      },
      required: ['request_id', 'notified_drivers', 'reasoning'],
    },
  },
];

// ── Haversine distance (km) ───────────────────────────────────────────────────

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

function makeToolHandlers(db) {
  return {
    get_pending_requests: async () => {
      const res = await db.query(
        `SELECT id, pickup_address, pickup_lat, pickup_lng, vehicle_info, notes, created_at
         FROM tow_requests WHERE status = 'pending' ORDER BY created_at ASC`
      );
      return res.rows;
    },

    get_available_drivers: async () => {
      const res = await db.query(
        `SELECT dp.id AS driver_profile_id, dp.user_id, u.name, u.phone,
                dp.vehicle_make, dp.vehicle_model, dp.truck_type, dp.rating, dp.total_jobs,
                ST_Y(dl.location::geometry) AS lat,
                ST_X(dl.location::geometry) AS lng,
                dl.updated_at AS location_updated_at
         FROM driver_profiles dp
         JOIN users u ON u.id = dp.user_id
         LEFT JOIN driver_locations dl ON dl.driver_id = dp.id
         WHERE dp.is_available = true
           AND dl.updated_at > NOW() - INTERVAL '5 minutes'`
      );
      return res.rows;
    },

    notify_driver: async ({ driver_user_id, request_id, pickup_address, distance_km }) => {
      const token = await getPushToken(db, driver_user_id);
      const distStr = distance_km != null ? ` (${distance_km.toFixed(1)} km away)` : '';
      await sendPush(
        token,
        'New Tow Request 🚨',
        `Pickup: ${pickup_address}${distStr}`,
        { requestId: request_id, type: 'new_job' }
      );
      return { ok: true, driver_user_id };
    },

    log_dispatch_decision: async ({ request_id, notified_drivers, reasoning }) => {
      console.log(`[Dispatch] Request ${request_id} → notified ${notified_drivers.length} driver(s): ${reasoning}`);
      return { ok: true };
    },
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You are the TowTrack dispatch agent for Australia.
Your job: for each pending tow request, identify the best available drivers nearby and notify them.

Rules:
- Only notify drivers within 30 km of the pickup location.
- Prefer drivers with higher ratings for the same distance.
- Notify up to 3 drivers per request so the customer gets a fast response.
- If no drivers are within 30 km, notify all available drivers.
- Always call log_dispatch_decision after notifying drivers for a request.
- Be concise and efficient — complete the full dispatch cycle in one pass.`;

// ── Main export ───────────────────────────────────────────────────────────────

async function runDispatch(db) {
  try {
    await runAgent({
      system:       SYSTEM,
      messages:     [{ role: 'user', content: 'Run a full dispatch cycle now.' }],
      tools:        TOOLS,
      toolHandlers: makeToolHandlers(db),
      maxTurns:     12,
      maxTokens:    2048,
    });
  } catch (err) {
    console.error('[Dispatch] Agent error:', err.message);
  }
}

module.exports = { runDispatch };
