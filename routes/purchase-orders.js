const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// List purchase orders
router.get('/', authMiddleware, (req, res) => {
  const { store_id, status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let where = [];
  let params = [];

  if (store_id) {
    where.push('po.store_id = ?');
    params.push(store_id);
  }

  if (status) {
    where.push('po.status = ?');
    params.push(status);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  // Get purchase orders with item count and total
  const query = `
    SELECT
      po.id,
      po.po_number,
      po.supplier_name,
      s.name as store_name,
      po.status,
      po.total,
      po.notes,
      po.created_at,
      po.received_at,
      COUNT(poi.id) as item_count,
      COALESCE(SUM(poi.quantity_ordered * poi.cost_per_unit), 0) as calculated_total
    FROM purchase_orders po
    JOIN stores s ON po.store_id = s.id
    LEFT JOIN purchase_order_items poi ON po.id = poi.po_id
    ${whereClause}
    GROUP BY po.id
    ORDER BY po.created_at DESC
    LIMIT ? OFFSET ?
  `;

  params.push(parseInt(limit), offset);
  const purchase_orders = db.prepare(query).all(...params);

  // Get total count
  const countQuery = `
    SELECT COUNT(DISTINCT po.id) as total FROM purchase_orders po
    JOIN stores s ON po.store_id = s.id
    ${whereClause}
  `;
  const countParams = where.length > 0 ? params.slice(0, -2) : [];
  const total = db.prepare(countQuery).get(...countParams);

  res.json({ purchase_orders, total: total.total, page: parseInt(page), limit: parseInt(limit) });
});

// Get single purchase order with items
router.get('/:id', authMiddleware, (req, res) => {
  const po = db.prepare(`
    SELECT po.*, s.name as store_name
    FROM purchase_orders po
    JOIN stores s ON po.store_id = s.id
    WHERE po.id = ?
  `).get(req.params.id);

  if (!po) return res.status(404).json({ error: 'Purchase order not found' });

  const items = db.prepare(`
    SELECT
      poi.id,
      poi.product_id,
      poi.quantity_ordered,
      poi.quantity_received,
      poi.cost_per_unit,
      p.sku,
      p.name as product_name
    FROM purchase_order_items poi
    JOIN products p ON poi.product_id = p.id
    WHERE poi.po_id = ?
    ORDER BY p.name
  `).all(req.params.id);

  res.json({ ...po, items });
});

// Create purchase order
router.post('/', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { supplier_name, invoice_reference, store_id, notes, items } = req.body;

  // Validation
  if (!supplier_name) return res.status(400).json({ error: 'Supplier name required' });
  if (!store_id) return res.status(400).json({ error: 'Store ID required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item required' });

  // Verify store exists
  const store = db.prepare('SELECT id FROM stores WHERE id = ?').get(store_id);
  if (!store) return res.status(400).json({ error: 'Store not found' });

  // Verify all products exist
  for (const item of items) {
    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(item.product_id);
    if (!product) return res.status(400).json({ error: `Product ${item.product_id} not found` });
    if (!item.quantity || item.quantity <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0' });
    if (!item.cost_price || item.cost_price < 0) return res.status(400).json({ error: 'Cost price required and must be >= 0' });
  }

  // Generate PO number: PO{YYYYMM}-{seq}
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastPO = db.prepare(
    "SELECT po_number FROM purchase_orders WHERE po_number LIKE ? ORDER BY po_number DESC LIMIT 1"
  ).get(`PO${yearMonth}-%`);

  let sequence = 1;
  if (lastPO) {
    const match = lastPO.po_number.match(/PO\d{6}-(\d+)/);
    if (match) {
      sequence = parseInt(match[1]) + 1;
    }
  }
  const po_number = `PO${yearMonth}-${String(sequence).padStart(4, '0')}`;

  // Calculate total cost
  let total_cost = 0;
  for (const item of items) {
    total_cost += item.quantity * item.cost_price;
  }

  // Insert purchase order
  const po_id = uuidv4();
  db.prepare(`
    INSERT INTO purchase_orders (id, po_number, supplier_name, invoice_reference, store_id, status, total, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(po_id, po_number, supplier_name, invoice_reference || null, store_id, 'ordered', total_cost, notes || null);

  // Insert purchase order items
  const insertItem = db.prepare(`
    INSERT INTO purchase_order_items (id, po_id, product_id, quantity_ordered, quantity_received, cost_per_unit)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const item of items) {
    insertItem.run(uuidv4(), po_id, item.product_id, item.quantity, 0, item.cost_price);
  }

  res.status(201).json({
    id: po_id,
    po_number,
    supplier_name,
    store_id,
    status: 'ordered',
    total: total_cost,
    item_count: items.length
  });
});

// Receive stock from purchase order
router.post('/:id/receive', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { items } = req.body;

  // Get purchase order
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });

  if (po.status === 'received') {
    return res.status(400).json({ error: 'Purchase order already received' });
  }

  if (po.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot receive cancelled purchase order' });
  }

  // Get current PO items
  const poItems = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(req.params.id);
  const poItemsMap = Object.fromEntries(poItems.map(item => [item.id, item]));

  // Validate items if provided, otherwise receive all
  const itemsToReceive = items || poItems.map(item => ({
    id: item.id,
    quantity: item.quantity_ordered - item.quantity_received
  }));

  // Start transaction
  const transaction = db.transaction(() => {
    for (const receiveItem of itemsToReceive) {
      const poItem = poItemsMap[receiveItem.id];
      if (!poItem) {
        throw new Error(`Purchase order item ${receiveItem.id} not found`);
      }

      const quantity = receiveItem.quantity || (poItem.quantity_ordered - poItem.quantity_received);
      if (quantity < 0) {
        throw new Error(`Invalid quantity for item ${receiveItem.id}`);
      }

      if (quantity > 0) {
        // Update quantity received on PO item
        const newQuantityReceived = poItem.quantity_received + quantity;
        db.prepare('UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?')
          .run(newQuantityReceived, poItem.id);

        // Add to inventory
        const inventory = db.prepare(
          'SELECT * FROM inventory WHERE product_id = ? AND store_id = ?'
        ).get(poItem.product_id, po.store_id);

        if (inventory) {
          db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(quantity, inventory.id);
        } else {
          db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
            .run(uuidv4(), poItem.product_id, po.store_id, quantity);
        }

        // Record stock movement
        db.prepare(`
          INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, reference_id, notes, user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          uuidv4(),
          poItem.product_id,
          po.store_id,
          'purchase_receive',
          quantity,
          req.params.id,
          `Received from PO ${po.po_number}`,
          req.user.id
        );
      }
    }

    // Check if entire PO is received
    const updatedItems = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ?').all(req.params.id);
    const allReceived = updatedItems.every(item => item.quantity_received >= item.quantity_ordered);

    // Update PO status
    const newStatus = allReceived ? 'received' : 'partial';

    if (allReceived) {
      db.prepare('UPDATE purchase_orders SET status = ?, received_at = CURRENT_TIMESTAMP, received_by = ? WHERE id = ?')
        .run(newStatus, req.user.id, req.params.id);
    } else {
      db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?')
        .run(newStatus, req.params.id);
    }
  });

  try {
    transaction();
    res.json({ success: true, status: 'received' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
// Update purchase order (draft only)
router.put('/:id', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { supplier_name, invoice_reference, notes, items } = req.body;

  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });

  if (po.status !== 'draft' && po.status !== 'ordered') {
    return res.status(400).json({ error: 'Can only edit draft or ordered purchase orders' });
  }

  const updates = [];
  const params = [];

  if (supplier_name !== undefined) {
    updates.push('supplier_name = ?');
    params.push(supplier_name);
  }
  if (invoice_reference !== undefined) {
    updates.push('invoice_reference = ?');
    params.push(invoice_reference);
  }
  if (notes !== undefined) {
    updates.push('notes = ?');
    params.push(notes);
  }

  if (updates.length > 0) {
    params.push(req.params.id);
    db.prepare(`UPDATE purchase_orders SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  // Update items if provided
  if (items && items.length > 0) {
    // Validate products exist
    for (const item of items) {
      const product = db.prepare('SELECT id FROM products WHERE id = ?').get(item.product_id);
      if (!product) return res.status(400).json({ error: `Product ${item.product_id} not found` });
      if (!item.quantity || item.quantity <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0' });
      if (!item.cost_price || item.cost_price < 0) return res.status(400).json({ error: 'Cost price required and must be >= 0' });
    }

    // Delete existing items and recalculate total
    db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(req.params.id);

    let total_cost = 0;
    const insertItem = db.prepare(`
      INSERT INTO purchase_order_items (id, po_id, product_id, quantity_ordered, quantity_received, cost_per_unit)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      insertItem.run(uuidv4(), req.params.id, item.product_id, item.quantity, 0, item.cost_price);
      total_cost += item.quantity * item.cost_price;
    }

    // Update total
    db.prepare('UPDATE purchase_orders SET total = ? WHERE id = ?').run(total_cost, req.params.id);
  }

  res.json({ success: true });
});

// Cancel purchase order
router.post('/:id/cancel', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });

  if (po.status === 'received') {
    return res.status(400).json({ error: 'Cannot cancel received purchase order' });
  }

  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run('cancelled', req.params.id);

  res.json({ success: true, status: 'cancelled' });
});

module.exports = router;
