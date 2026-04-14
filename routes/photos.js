// Photos storage — webcam/phone photos attached to any entity (repair, sale, product, etc)
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Create table (idempotent)
db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,         -- 'repair', 'sale', 'product', etc.
    entity_id TEXT NOT NULL,           -- id of the linked record
    tag TEXT,                          -- 'before', 'after', 'damage', etc.
    data TEXT NOT NULL,                -- base64 dataURL (image/jpeg;base64,...)
    mime TEXT DEFAULT 'image/jpeg',
    uploaded_by TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_photos_entity ON photos(entity_type, entity_id);
`);

// Upload a photo
// Body: { entity_type, entity_id, tag?, data (dataURL), notes? }
router.post('/', authMiddleware, (req, res) => {
  const { entity_type, entity_id, tag, data, notes } = req.body || {};
  if (!entity_type || !entity_id || !data) {
    return res.status(400).json({ error: 'entity_type, entity_id, and data required' });
  }
  if (typeof data !== 'string' || !data.startsWith('data:image/')) {
    return res.status(400).json({ error: 'data must be a dataURL starting with data:image/' });
  }
  // Protect against massive uploads
  if (data.length > 8 * 1024 * 1024) { // ~8MB base64 ≈ ~6MB image
    return res.status(413).json({ error: 'Image too large (max ~6MB)' });
  }
  const mimeMatch = data.match(/^data:([^;]+);base64,/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const id = uuidv4();
  db.prepare(
    'INSERT INTO photos (id, entity_type, entity_id, tag, data, mime, uploaded_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, entity_type, entity_id, tag || null, data, mime, req.user.id, notes || null);
  res.status(201).json({ id, entity_type, entity_id, tag, mime, created_at: new Date().toISOString() });
});

// List photos for an entity (returns metadata only, not image data)
router.get('/', authMiddleware, (req, res) => {
  const { entity_type, entity_id } = req.query;
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id required' });
  const rows = db.prepare(
    'SELECT id, entity_type, entity_id, tag, mime, uploaded_by, notes, created_at FROM photos WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC'
  ).all(entity_type, entity_id);
  res.json(rows);
});

// Get single photo with data (for displaying)
router.get('/:id', authMiddleware, (req, res) => {
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// Stream image directly (for <img src="/api/photos/ID/raw">)
router.get('/:id/raw', authMiddleware, (req, res) => {
  const p = db.prepare('SELECT data, mime FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Not found');
  const base64 = (p.data || '').split(',')[1] || '';
  const buf = Buffer.from(base64, 'base64');
  res.setHeader('Content-Type', p.mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(buf);
});

// Delete
router.delete('/:id', authMiddleware, (req, res) => {
  const p = db.prepare('SELECT id FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
