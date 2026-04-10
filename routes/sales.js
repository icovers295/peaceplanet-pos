const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function generateReceiptNumber() {
  const date = new Date();
  const prefix = `PP${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const last = db.prepare("SELECT receipt_number FROM sales WHERE receipt_number LIKE ? ORDER BY receipt_number DESC LIMIT 1").get(`${prefix}%`);
  const seq = last ? parseInt(last.receipt_number.slice(-4)) + 1 : 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

// Create sale
router.post('/', authMiddleware, (req, res) => {
  const { store_id, customer_id, items, payment_method, discount_amount, tax_rate, notes } = req.body;

  if (!store_id || !items || items.length === 0) {
    return res.status(400).json({ error: 'Store and at least one item required' });
  }

  const saleId = uuidv4();
  const receiptNumber = generateReceiptNumber();

  let subtotal = 0;
  const processedItems = [];

  // Validate and process items
  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
    if (!product) return res.status(400).json({ error: `Product not found: ${item.product_id}` });

    const unitPrice = item.unit_price || product.sell_price;
    const qty = item.quantity || 1;
    const itemDiscount = item.discount || 0;
    const itemTotal = (unitPrice * qty) - itemDiscount;

    // Check stock (for non-serialized items)
    if (!product.is_serialized) {
      const inv = db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(item.product_id, store_id);
      if (!inv || inv.quantity < qty) {
        return res.status(400).json({ error: `Insufficient stock for ${product.name}. Available: ${inv ? inv.quantity : 0}` });
      }
    }

    // For serialized items, check serial item exists and is available
    if (product.is_serialized && item.serial_item_id) {
      const serialItem = db.prepare('SELECT * FROM serial_items WHERE id = ? AND status = ?').get(item.serial_item_id, 'in_stock');
      if (!serialItem) {
        return res.status(400).json({ error: `Serial item not available for ${product.name}` });
      }
    }

    subtotal += itemTotal;
    processedItems.push({
      id: uuidv4(),
      sale_id: saleId,
      product_id: item.product_id,
      serial_item_id: item.serial_item_id || null,
      quantity: qty,
      unit_price: unitPrice,
      discount: itemDiscount,
      total: itemTotal
    });
  }

  const disc = discount_amount || 0;
  const taxAmt = tax_rate ? (subtotal - disc) * (tax_rate / 100) : 0;
  const total = subtotal - disc + taxAmt;

  // Insert sale
  db.prepare(`INSERT INTO sales (id, receipt_number, store_id, user_id, customer_id, subtotal, discount_amount, tax_amount, total, payment_method, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(saleId, receiptNumber, store_id, req.user.id, customer_id || null, subtotal, disc, taxAmt, total, payment_method || 'cash', notes || '');

  // Insert sale items and update stock
  const insertItem = db.prepare('INSERT INTO sale_items (id, sale_id, product_id, serial_item_id, quantity, unit_price, discount, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const updateStock = db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?');
  const insertMovement = db.prepare('INSERT INTO stock_movements (id, product_id, store_id, serial_item_id, movement_type, quantity, reference_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

  for (const item of processedItems) {
    insertItem.run(item.id, item.sale_id, item.product_id, item.serial_item_id, item.quantity, item.unit_price, item.discount, item.total);
    updateStock.run(item.quantity, item.product_id, store_id);
    insertMovement.run(uuidv4(), item.product_id, store_id, item.serial_item_id, 'sale', -item.quantity, saleId, req.user.id);

    // Mark serialized item as sold
    if (item.serial_item_id) {
      db.prepare('UPDATE serial_items SET status = ? WHERE id = ?').run('sold', item.serial_item_id);
    }
  }

  res.status(201).json({
    id: saleId,
    receipt_number: receiptNumber,
    subtotal,
    discount_amount: disc,
    tax_amount: taxAmt,
    total,
    items: processedItems
  });
});

// List sales
router.get('/', authMiddleware, (req, res) => {
  const { store_id, date_from, date_to, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let where = [];
  let params = [];

  if (store_id) { where.push('s.store_id = ?'); params.push(store_id); }
  if (date_from) { where.push('s.created_at >= ?'); params.push(date_from); }
  if (date_to) { where.push('s.created_at <= ?'); params.push(date_to + ' 23:59:59'); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const sales = db.prepare(`
    SELECT s.*, u.first_name || ' ' || u.last_name as cashier_name,
           st.name as store_name, c.first_name || ' ' || COALESCE(c.last_name, '') as customer_name
    FROM sales s
    JOIN users u ON s.user_id = u.id
    JOIN stores st ON s.store_id = st.id
    LEFT JOIN customers c ON s.customer_id = c.id
    ${whereClause}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json(sales);
});

// Daily sales summary (must be before /:id to avoid route conflict)
router.get('/reports/summary', authMiddleware, (req, res) => {
  const { store_id, date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  let storeFilter = '';
  let params = [targetDate];
  if (store_id) {
    storeFilter = 'AND store_id = ?';
    params.push(store_id);
  }

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_transactions,
      COALESCE(SUM(total), 0) as total_revenue,
      COALESCE(SUM(discount_amount), 0) as total_discounts,
      COALESCE(AVG(total), 0) as average_transaction,
      SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END) as cash_total,
      SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END) as card_total
    FROM sales
    WHERE date(created_at) = date(?) AND payment_status != 'refunded' ${storeFilter}
  `).get(...params);

  let topStoreFilter = store_id ? 'AND s.store_id = ?' : '';
  let topParams = store_id ? [targetDate, store_id] : [targetDate];

  // Top products today
  const topProducts = db.prepare(`
    SELECT p.name, p.sku, SUM(si.quantity) as qty_sold, SUM(si.total) as revenue
    FROM sale_items si
    JOIN sales s ON si.sale_id = s.id
    JOIN products p ON si.product_id = p.id
    WHERE date(s.created_at) = date(?) AND s.payment_status != 'refunded' ${topStoreFilter}
    GROUP BY p.id
    ORDER BY qty_sold DESC
    LIMIT 10
  `).all(...topParams);

  res.json({ date: targetDate, ...summary, top_products: topProducts });
});

// Get sale detail
router.get('/:id', authMiddleware, (req, res) => {
  const sale = db.prepare(`
    SELECT s.*, u.first_name || ' ' || u.last_name as cashier_name,
           st.name as store_name, c.first_name || ' ' || COALESCE(c.last_name, '') as customer_name,
           c.phone as customer_phone, c.email as customer_email
    FROM sales s
    JOIN users u ON s.user_id = u.id
    JOIN stores st ON s.store_id = st.id
    LEFT JOIN customers c ON s.customer_id = c.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!sale) return res.status(404).json({ error: 'Sale not found' });

  const items = db.prepare(`
    SELECT si.*, p.name as product_name, p.sku,
           ser.serial_number, ser.imei
    FROM sale_items si
    JOIN products p ON si.product_id = p.id
    LEFT JOIN serial_items ser ON si.serial_item_id = ser.id
    WHERE si.sale_id = ?
  `).all(req.params.id);

  res.json({ ...sale, items });
});

// Refund a sale
router.post('/:id/refund', authMiddleware, (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  if (sale.payment_status === 'refunded') return res.status(400).json({ error: 'Already refunded' });

  // Restore stock
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id);
  for (const item of items) {
    db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
      .run(item.quantity, item.product_id, sale.store_id);

    if (item.serial_item_id) {
      db.prepare('UPDATE serial_items SET status = ? WHERE id = ?').run('in_stock', item.serial_item_id);
    }

    db.prepare('INSERT INTO stock_movements (id, product_id, store_id, serial_item_id, movement_type, quantity, reference_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), item.product_id, sale.store_id, item.serial_item_id, 'return', item.quantity, sale.id, req.user.id);
  }

  db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run('refunded', req.params.id);
  res.json({ success: true });
});

module.exports = router;
