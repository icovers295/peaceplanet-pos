const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// Ensure tables exist (idempotent). Runs on first load of this module.
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_orders (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    notes TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    submitted_at DATETIME,
    processed_at DATETIME,
    FOREIGN KEY (store_id) REFERENCES stores(id)
  );
  CREATE TABLE IF NOT EXISTS stock_order_items (
    id TEXT PRIMARY KEY,
    stock_order_id TEXT NOT NULL,
    product_id TEXT,
    sku TEXT,
    name TEXT,
    quantity INTEGER DEFAULT 1,
    needed_by DATE,
    customer_name TEXT,
    priority TEXT DEFAULT 'normal',
    supplier TEXT,
    notes TEXT,
    added_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (stock_order_id) REFERENCES stock_orders(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_stock_orders_store ON stock_orders(store_id);
  CREATE INDEX IF NOT EXISTS idx_stock_order_items_order ON stock_order_items(stock_order_id);
`);

for (const sql of [
  `ALTER TABLE stock_order_items ADD COLUMN needed_by DATE`,
  `ALTER TABLE stock_order_items ADD COLUMN customer_name TEXT`,
  `ALTER TABLE stock_order_items ADD COLUMN priority TEXT DEFAULT 'normal'`,
  `ALTER TABLE stock_order_items ADD COLUMN supplier TEXT`,
]) { try { db.exec(sql); } catch (_) {} }

function getOrCreateOpenOrder(storeId, userId) {
  let order = db.prepare(
    `SELECT * FROM stock_orders WHERE store_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`
  ).get(storeId);
  if (!order) {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO stock_orders (id, store_id, status, created_by) VALUES (?, ?, 'open', ?)`
    ).run(id, storeId, userId || null);
    order = db.prepare(`SELECT * FROM stock_orders WHERE id = ?`).get(id);
  }
  return order;
}

function attachItems(order) {
  const items = db.prepare(
    `SELECT soi.*, p.sell_price, p.cost_price,
            inv.quantity as current_stock
     FROM stock_order_items soi
     LEFT JOIN products p ON soi.product_id = p.id
     LEFT JOIN inventory inv ON inv.product_id = soi.product_id AND inv.store_id = ?
     WHERE soi.stock_order_id = ?
     ORDER BY soi.created_at DESC`
  ).all(order.store_id, order.id);
  return { ...order, items, item_count: items.length };
}

router.get('/current', authMiddleware, (req, res) => {
  const store_id = req.query.store_id;
  if (!store_id) return res.status(400).json({ error: 'store_id required' });
  const order = getOrCreateOpenOrder(store_id, req.user.id);
  res.json(attachItems(order));
});

router.post('/current/items', authMiddleware, (req, res) => {
  const { store_id, sku, product_id, quantity = 1, needed_by, customer_name, priority, supplier, notes } = req.body;
  if (!store_id) return res.status(400).json({ error: 'store_id required' });
  if (!sku && !product_id) return res.status(400).json({ error: 'sku or product_id required' });

  let product = null;
  if (product_id) {
    product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(product_id);
  } else if (sku) {
    product = db.prepare(`SELECT * FROM products WHERE sku = ? COLLATE NOCASE`).get(sku);
  }

  const order = getOrCreateOpenOrder(store_id, req.user.id);
  const qty = Math.max(1, parseInt(quantity) || 1);
  const pri = (priority === 'urgent') ? 'urgent' : 'normal';

  if (product && !customer_name && !needed_by) {
    const existing = db.prepare(
      `SELECT * FROM stock_order_items WHERE stock_order_id = ? AND product_id = ? AND (customer_name IS NULL OR customer_name = '') AND (needed_by IS NULL)`
    ).get(order.id, product.id);
    if (existing) {
      db.prepare(`UPDATE stock_order_items SET quantity = quantity + ? WHERE id = ?`).run(qty, existing.id);
      return res.json(attachItems(order));
    }
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO stock_order_items (id, stock_order_id, product_id, sku, name, quantity, needed_by, customer_name, priority, supplier, notes, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    order.id,
    product ? product.id : null,
    product ? product.sku : (sku || null),
    product ? product.name : (sku || 'Unknown item'),
    qty,
    needed_by || null,
    customer_name || null,
    pri,
    supplier || null,
    notes || null,
    req.user.id
  );

  res.json(attachItems(order));
});

router.patch('/items/:id', authMiddleware, (req, res) => {
  const item = db.prepare(`SELECT * FROM stock_order_items WHERE id = ?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const fields = ['quantity','needed_by','customer_name','priority','supplier','notes'];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      let v = req.body[f];
      if (f === 'quantity') v = Math.max(1, parseInt(v) || 1);
      if (f === 'priority') v = (v === 'urgent') ? 'urgent' : 'normal';
      db.prepare(`UPDATE stock_order_items SET ${f} = ? WHERE id = ?`).run(v === '' ? null : v, req.params.id);
    }
  }
  const order = db.prepare(`SELECT * FROM stock_orders WHERE id = ?`).get(item.stock_order_id);
  res.json(attachItems(order));
});

router.delete('/items/:id', authMiddleware, (req, res) => {
  const item = db.prepare(`SELECT * FROM stock_order_items WHERE id = ?`).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare(`DELETE FROM stock_order_items WHERE id = ?`).run(req.params.id);
  const order = db.prepare(`SELECT * FROM stock_orders WHERE id = ?`).get(item.stock_order_id);
  res.json(attachItems(order));
});

router.post('/:id/submit', authMiddleware, (req, res) => {
  const order = db.prepare(`SELECT * FROM stock_orders WHERE id = ?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'open') return res.status(400).json({ error: 'Order is not open' });
  db.prepare(
    `UPDATE stock_orders SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/process', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const order = db.prepare(`SELECT * FROM stock_orders WHERE id = ?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.prepare(
    `UPDATE stock_orders SET status = 'processed', processed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/cancel', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  db.prepare(`UPDATE stock_orders SET status = 'cancelled' WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

router.get('/', authMiddleware, (req, res) => {
  const { store_id, status } = req.query;
  const where = []; const params = [];
  if (store_id) { where.push('so.store_id = ?'); params.push(store_id); }
  if (status) { where.push('so.status = ?'); params.push(status); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orders = db.prepare(`
    SELECT so.*, s.name as store_name,
           (SELECT COUNT(*) FROM stock_order_items WHERE stock_order_id = so.id) as item_count,
           (SELECT COALESCE(SUM(quantity),0) FROM stock_order_items WHERE stock_order_id = so.id) as total_qty
    FROM stock_orders so
    JOIN stores s ON so.store_id = s.id
    ${whereClause}
    ORDER BY so.created_at DESC
    LIMIT 200
  `).all(...params);
  res.json({ orders });
});

router.get('/:id', authMiddleware, (req, res) => {
  const order = db.prepare(`SELECT * FROM stock_orders WHERE id = ?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(attachItems(order));
});

module.exports = router;