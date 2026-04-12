const express  = require('express');
const { body, validationResult } = require('express-validator');
const db       = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ── Deals ─────────────────────────────────────────────────────────────────────

// GET /deals — list all deals for the authenticated user
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         d.*,
         (SELECT COUNT(*) FROM deal_parties  WHERE deal_id = d.id) AS party_count,
         (SELECT COUNT(*) FROM deal_tasks    WHERE deal_id = d.id AND done = FALSE) AS pending_tasks,
         (SELECT COUNT(*) FROM deal_messages WHERE deal_id = d.id) AS message_count,
         (SELECT content    FROM deal_messages WHERE deal_id = d.id ORDER BY created_at DESC LIMIT 1) AS last_message,
         (SELECT channel    FROM deal_messages WHERE deal_id = d.id ORDER BY created_at DESC LIMIT 1) AS last_channel,
         (SELECT created_at FROM deal_messages WHERE deal_id = d.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
       FROM deals d
       WHERE d.owner_id = $1
       ORDER BY d.updated_at DESC`,
      [req.user.id]
    );
    res.json({ deals: rows });
  } catch (err) {
    console.error('GET /deals error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /deals — create a new deal
router.post(
  '/',
  [
    body('address').trim().notEmpty().withMessage('Address is required'),
    body('dealType').isIn(['purchase', 'rental', 'enquiry']).withMessage('Invalid deal type'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { address, suburb, dealType, settlementDate, price } = req.body;
    try {
      const { rows } = await db.query(
        `INSERT INTO deals (owner_id, address, suburb, deal_type, settlement_date, price)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [req.user.id, address.trim(), suburb?.trim() || null, dealType, settlementDate || null, price || null]
      );
      // Auto-add the creator as a party (Buyer by default)
      await db.query(
        `INSERT INTO deal_parties (deal_id, user_id, name, email, role, status)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [rows[0].id, req.user.id, req.user.name || 'You', req.user.email, 'Buyer']
      );
      res.status(201).json({ deal: rows[0] });
    } catch (err) {
      console.error('POST /deals error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /deals/:id — update deal status or details
router.patch('/:id', async (req, res) => {
  const { status, settlementDate, price } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE deals
       SET status = COALESCE($1, status),
           settlement_date = COALESCE($2, settlement_date),
           price = COALESCE($3, price),
           updated_at = NOW()
       WHERE id = $4 AND owner_id = $5
       RETURNING *`,
      [status || null, settlementDate || null, price || null, req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Deal not found' });
    res.json({ deal: rows[0] });
  } catch (err) {
    console.error('PATCH /deals/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /deals/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM deals WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Parties ───────────────────────────────────────────────────────────────────

// GET /deals/:id/parties
router.get('/:id/parties', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM deal_parties WHERE deal_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ parties: rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /deals/:id/parties
router.post('/:id/parties', async (req, res) => {
  const { name, email, phone, role } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'Name and role are required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO deal_parties (deal_id, name, email, phone, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, name.trim(), email?.trim() || null, phone?.trim() || null, role]
    );
    res.status(201).json({ party: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /deals/:id/parties/:partyId
router.delete('/:id/parties/:partyId', async (req, res) => {
  try {
    await db.query('DELETE FROM deal_parties WHERE id = $1 AND deal_id = $2', [req.params.partyId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Messages ──────────────────────────────────────────────────────────────────

// GET /deals/:id/messages
router.get('/:id/messages', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM deal_messages WHERE deal_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ messages: rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /deals/:id/messages
router.post('/:id/messages', async (req, res) => {
  const { content, channel, senderName, senderRole } = req.body;
  if (!content) return res.status(400).json({ error: 'Content is required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO deal_messages (deal_id, sender_id, sender_name, sender_role, channel, content)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, req.user.id, senderName || req.user.name, senderRole || 'Buyer', channel || 'in_app', content]
    );
    // Touch deal updated_at
    await db.query('UPDATE deals SET updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.status(201).json({ message: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

// GET /deals/:id/tasks
router.get('/:id/tasks', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM deal_tasks WHERE deal_id = $1 ORDER BY done ASC, created_at ASC',
      [req.params.id]
    );
    res.json({ tasks: rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /deals/:id/tasks
router.post('/:id/tasks', async (req, res) => {
  const { title, assigneeName, assigneeRole, dueDate, priority } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO deal_tasks (deal_id, title, assignee_name, assignee_role, due_date, priority)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, title.trim(), assigneeName || null, assigneeRole || null, dueDate || null, priority || 'medium']
    );
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /deals/:id/tasks/:taskId — toggle done or update
router.patch('/:id/tasks/:taskId', async (req, res) => {
  const { done, title, dueDate, priority } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE deal_tasks
       SET done       = COALESCE($1, done),
           title      = COALESCE($2, title),
           due_date   = COALESCE($3, due_date),
           priority   = COALESCE($4, priority),
           updated_at = NOW()
       WHERE id = $5 AND deal_id = $6
       RETURNING *`,
      [done ?? null, title || null, dueDate || null, priority || null, req.params.taskId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /deals/:id/tasks/:taskId
router.delete('/:id/tasks/:taskId', async (req, res) => {
  try {
    await db.query('DELETE FROM deal_tasks WHERE id = $1 AND deal_id = $2', [req.params.taskId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Documents ─────────────────────────────────────────────────────────────────

// GET /deals/:id/documents
router.get('/:id/documents', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM deal_documents WHERE deal_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ documents: rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /deals/:id/documents
router.post('/:id/documents', async (req, res) => {
  const { name, storageUrl, fileSize, uploadedBy } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO deal_documents (deal_id, name, storage_url, file_size, uploaded_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, name.trim(), storageUrl || null, fileSize || null, uploadedBy || req.user.name]
    );
    res.status(201).json({ document: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /deals/:id/documents/:docId — update signing status
router.patch('/:id/documents/:docId', async (req, res) => {
  const { signStatus } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE deal_documents SET sign_status = $1 WHERE id = $2 AND deal_id = $3 RETURNING *`,
      [signStatus, req.params.docId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Document not found' });
    res.json({ document: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
