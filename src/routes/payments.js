const express = require('express');
const Stripe  = require('stripe');
const db      = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// POST /payments/create-intent
// Customer calls this when they want to pay for an accepted job.
// Returns a clientSecret the mobile app uses to show the payment sheet.
router.post('/create-intent', authenticate, requireRole('customer'), async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: 'requestId required' });

  try {
    // Fetch the job and confirm it belongs to this customer
    const result = await db.query(
      `SELECT tr.*, u.email AS customer_email, u.name AS customer_name
       FROM tow_requests tr
       JOIN users u ON u.id = tr.customer_id
       WHERE tr.id = $1 AND tr.customer_id = $2`,
      [requestId, req.user.id]
    );
    const job = result.rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'pending') return res.status(400).json({ error: 'No driver has accepted yet' });
    if (job.status === 'cancelled') return res.status(400).json({ error: 'Job was cancelled' });
    if (job.payment_status === 'paid') return res.status(400).json({ error: 'Already paid' });

    // Prefer final_price (set when job completes) over estimated_price (set on acceptance)
    const price = parseFloat(job.final_price ?? job.estimated_price);
    if (!price || price <= 0) return res.status(400).json({ error: 'No price set for this job' });

    // Amount in cents (AUD)
    const amountCents = Math.round(price * 100);

    // Create or reuse the PaymentIntent
    let intentId = job.payment_intent_id;
    let clientSecret;

    if (intentId) {
      // Reuse existing intent (customer reopened the payment sheet)
      const existing = await stripe.paymentIntents.retrieve(intentId);
      if (existing.status === 'succeeded') {
        return res.status(400).json({ error: 'Already paid' });
      }
      clientSecret = existing.client_secret;
    } else {
      const intent = await stripe.paymentIntents.create({
        amount:   amountCents,
        currency: 'aud',
        metadata: { requestId, customerId: req.user.id },
        automatic_payment_methods: { enabled: true },
        receipt_email: job.customer_email,
        description: `TowTrack Job #${requestId.slice(0, 8)}`,
      });
      intentId    = intent.id;
      clientSecret = intent.client_secret;

      // Persist the intent ID
      await db.query(
        'UPDATE tow_requests SET payment_intent_id = $1 WHERE id = $2',
        [intentId, requestId]
      );
    }

    return res.json({ clientSecret, amount: amountCents, currency: 'aud' });
  } catch (err) {
    console.error('Create intent error:', err);
    return res.status(500).json({ error: 'Payment setup failed' });
  }
});

// POST /payments/webhook
// Stripe calls this when a payment is confirmed.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const requestId = intent.metadata?.requestId;
    if (requestId) {
      await db.query(
        `UPDATE tow_requests SET payment_status = 'paid' WHERE id = $1`,
        [requestId]
      );
      console.log(`Payment confirmed for job ${requestId}`);
    }
  }

  return res.json({ received: true });
});

// GET /payments/status/:requestId
// Customer polls this to check if payment went through.
router.get('/status/:requestId', authenticate, requireRole('customer'), async (req, res) => {
  try {
    const result = await db.query(
      'SELECT payment_status FROM tow_requests WHERE id = $1 AND customer_id = $2',
      [req.params.requestId, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    return res.json({ paymentStatus: result.rows[0].payment_status ?? 'unpaid' });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
