// Sale edit/refund endpoints — Phase 1 of POS editing features
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function getSale(id) {
  return db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
}

function recalcTotals(saleId) {
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  const subtotal = items.reduce((s, i) => s + (i.total || 0), 0);
  const sale = getSale(saleId);
  const disc = sale.discount_amount || 0;
  const taxRate = sale.tax_amount && sale.subtotal
    ? (sale.tax_amount / (sale.subtotal - disc)) * 100
    : 0;
  const taxAmt = taxRate ? (subtotal - disc) * (taxRate / 100) : 0;
  const total = subtotal - disc + taxAmt;
  db.prepare('UPDATE sales SET subtotal = ?, tax_amount = ?, total = ? WHERE id = ?')
    .run(subtotal, taxAmt, total, saleId);
  return { subtotal, tax_amount: taxAmt, total };
}

function restoreStock(item, storeId, userId, reason = 'return') {
  db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
    .run(item.quantity, item.product_id, storeId);
  if (item.serial_item_id) {
    db.prepare('UPDATE serial_items SET status = ? WHERE id = ?').run('in_stock', item.serial_item_id);
  }
  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, serial_item_id, movement_type, quantity, reference_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), item.product_id, storeId, item.serial_item_id || null, reason, item.quantity, item.sale_id, userId);
}

function deductStock(productId, qty, storeId, userId, saleId) {
  const inv = db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId);
  if (!inv || inv.quantity < qty) throw new Error('Insufficient stock');
  db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
    .run(qty, productId, storeId);
  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, serial_item_id, movement_type, quantity, reference_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), productId, storeId, null, 'sale', -qty, saleId, userId);
}

// Refund a single line item
router.post('/:id/items/:itemId/refund', authMiddleware, (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const item = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.refunded) return res.status(400).json({ error: 'Item already refunded' });

  restoreStock(item, sale.store_id, req.user.id, 'return');
  // Mark item refunded (add column if missing)
  try { db.exec('ALTER TABLE sale_items ADD COLUMN refunded INTEGER DEFAULT 0'); } catch(_){}
  db.prepare('UPDATE sale_items SET refunded = 1, total = 0 WHERE id = ?').run(item.id);
  const totals = recalcTotals(sale.id);
  res.json({ success: true, ...totals });
});

// Edit a line item (price and/or quantity)
router.patch('/:id/items/:itemId', authMiddleware, (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const item = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const newQty = req.body.quantity != null ? Math.max(1, parseInt(req.body.quantity)) : item.quantity;
  const newPrice = req.body.unit_price != null ? Number(req.body.unit_price) : item.unit_price;
  const newDisc = req.body.discount != null ? Number(req.body.discount) : (item.discount || 0);

  // Adjust stock if qty changed
  const qtyDiff = newQty - item.quantity;
  if (qtyDiff > 0) {
    try { deductStock(item.product_id, qtyDiff, sale.store_id, req.user.id, sale.id); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  } else if (qtyDiff < 0) {
    restoreStock({ ...item, quantity: -qtyDiff }, sale.store_id, req.user.id, 'adjustment');
  }

  const newTotal = (newPrice * newQty) - newDisc;
  db.prepare('UPDATE sale_items SET quantity = ?, unit_price = ?, discount = ?, total = ? WHERE id = ?')
    .run(newQty, newPrice, newDisc, newTotal, item.id);
  const totals = recalcTotals(sale.id);
  res.json({ success: true, ...totals });
});

// Delete a line item (like refund, but fully removes the row)
router.delete('/:id/items/:itemId', authMiddleware, (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const item = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (!item.refunded) restoreStock(item, sale.store_id, req.user.id, 'return');
  db.prepare('DELETE FROM sale_items WHERE id = ?').run(item.id);
  const totals = recalcTotals(sale.id);
  res.json({ success: true, ...totals });
});

// Add a new line item to an existing sale
router.post('/:id/items', authMiddleware, (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const { product_id, sku, quantity = 1, unit_price, discount = 0 } = req.body;

  let product = null;
  if (product_id) product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  else if (sku) product = db.prepare('SELECT * FROM products WHERE sku = ? COLLATE NOCASE').get(sku);
  if (!product) return res.status(400).json({ error: 'Product not found' });

  const qty = Math.max(1, parseInt(quantity) || 1);
  const price = unit_price != null ? Number(unit_price) : product.sell_price;
  try { deductStock(product.id, qty, sale.store_id, req.user.id, sale.id); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const total = (price * qty) - (discount || 0);
  const itemId = uuidv4();
  db.prepare('INSERT INTO sale_items (id, sale_id, product_id, serial_item_id, quantity, unit_price, discount, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(itemId, sale.id, product.id, null, qty, price, discount || 0, total);
  const totals = recalcTotals(sale.id);
  res.json({ success: true, item_id: itemId, ...totals });
});

// Override sale header (discount, notes, payment method)
router.patch('/:id', authMiddleware, (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const fields = ['discount_amount','notes','payment_method','customer_id'];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      db.prepare(`UPDATE sales SET ${f} = ? WHERE id = ?`).run(req.body[f], sale.id);
    }
  }
  const totals = recalcTotals(sale.id);
  res.json({ success: true, ...totals });
});

module.exports = router;
