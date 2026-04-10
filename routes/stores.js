const express = require('express');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// List stores — hides Main from non-admins
router.get('/', authMiddleware, (req, res) => {
  let stores;
  if (req.user.role === 'admin') {
    stores = db.prepare('SELECT * FROM stores ORDER BY is_main DESC, name').all();
  } else {
    // Non-admins: only see stores they have access to, excluding Main
    stores = db.prepare(`
      SELECT s.* FROM stores s
      JOIN user_store_access usa ON s.id = usa.store_id
      WHERE usa.user_id = ? AND s.is_main = 0
      ORDER BY s.name
    `).all(req.user.id);
  }
  res.json(stores);
});

// Get store details with stats
router.get('/:id', authMiddleware, (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id);
  if (!store) return res.status(404).json({ error: 'Store not found' });

  // Non-admins can't view Main store
  if (store.is_main && !req.user.canSeeMainStore) {
    return res.status(403).json({ error: 'No access to this store' });
  }

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM inventory WHERE store_id = ? AND quantity > 0) as products_in_stock,
      (SELECT COALESCE(SUM(total), 0) FROM sales WHERE store_id = ? AND date(created_at) = date('now')) as today_sales,
      (SELECT COUNT(*) FROM sales WHERE store_id = ? AND date(created_at) = date('now')) as today_transactions,
      (SELECT COUNT(*) FROM repairs WHERE store_id = ? AND status NOT IN ('completed', 'collected')) as active_repairs
  `).get(req.params.id, req.params.id, req.params.id, req.params.id);

  res.json({ ...store, ...stats });
});

// Update store (admin only)
router.put('/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const { name, address, phone, email } = req.body;
  db.prepare('UPDATE stores SET name = COALESCE(?, name), address = COALESCE(?, address), phone = COALESCE(?, phone), email = COALESCE(?, email) WHERE id = ?')
    .run(name, address, phone, email, req.params.id);
  res.json({ success: true });
});

module.exports = router;
