const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

function generateTicketNumber() {
  const date = new Date();
  const prefix = `RPR${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  const last = db.prepare("SELECT ticket_number FROM repairs WHERE ticket_number LIKE ? ORDER BY ticket_number DESC LIMIT 1").get(`${prefix}%`);
  const seq = last ? parseInt(last.ticket_number.slice(-5)) + 1 : 1;
  return `${prefix}-${String(seq).padStart(5, '0')}`;
}

// Create repair ticket
router.post('/', authMiddleware, (req, res) => {
  const {
    store_id, customer_id, device_type, device_brand, device_model,
    imei, issue_description, estimated_cost, priority, estimated_completion, assigned_to, notes
  } = req.body;

  if (!store_id || !issue_description) {
    return res.status(400).json({ error: 'Store and issue description required' });
  }

  // Create customer if details provided but no customer_id
  let custId = customer_id;
  if (!custId && req.body.customer_name) {
    const nameParts = req.body.customer_name.split(' ');
    custId = uuidv4();
    db.prepare('INSERT INTO customers (id, first_name, last_name, phone, email) VALUES (?, ?, ?, ?, ?)')
      .run(custId, nameParts[0], nameParts.slice(1).join(' ') || '', req.body.customer_phone || '', req.body.customer_email || '');
  }

  const id = uuidv4();
  const ticketNumber = generateTicketNumber();

  db.prepare(`INSERT INTO repairs (id, ticket_number, store_id, customer_id, assigned_to, device_type, device_brand,
    device_model, imei, issue_description, estimated_cost, priority, estimated_completion, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ticketNumber, store_id, custId || null, assigned_to || null, device_type || '',
      device_brand || '', device_model || '', imei || '', issue_description,
      estimated_cost || 0, priority || 'normal', estimated_completion || null, notes || '');

  res.status(201).json({ id, ticket_number: ticketNumber });
});

// List repairs
router.get('/', authMiddleware, (req, res) => {
  const { store_id, status, search, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let where = [];
  let params = [];

  if (store_id) { where.push('r.store_id = ?'); params.push(store_id); }
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (search) {
    where.push('(r.ticket_number LIKE ? OR r.device_model LIKE ? OR r.imei LIKE ? OR c.first_name LIKE ? OR c.phone LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const repairs = db.prepare(`
    SELECT r.*, st.name as store_name,
           c.first_name || ' ' || COALESCE(c.last_name, '') as customer_name, c.phone as customer_phone,
           u.first_name || ' ' || u.last_name as assigned_to_name
    FROM repairs r
    JOIN stores st ON r.store_id = st.id
    LEFT JOIN customers c ON r.customer_id = c.id
    LEFT JOIN users u ON r.assigned_to = u.id
    ${whereClause}
    ORDER BY
      CASE r.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
      r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json(repairs);
});

// Get repair detail
router.get('/:id', authMiddleware, (req, res) => {
  const repair = db.prepare(`
    SELECT r.*, st.name as store_name,
           c.first_name || ' ' || COALESCE(c.last_name, '') as customer_name,
           c.phone as customer_phone, c.email as customer_email,
           u.first_name || ' ' || u.last_name as assigned_to_name
    FROM repairs r
    JOIN stores st ON r.store_id = st.id
    LEFT JOIN customers c ON r.customer_id = c.id
    LEFT JOIN users u ON r.assigned_to = u.id
    WHERE r.id = ?
  `).get(req.params.id);

  if (!repair) return res.status(404).json({ error: 'Repair not found' });

  const parts = db.prepare(`
    SELECT rp.*, p.name as product_name, p.sku
    FROM repair_parts rp
    JOIN products p ON rp.product_id = p.id
    WHERE rp.repair_id = ?
  `).all(req.params.id);

  res.json({ ...repair, parts });
});

// Update repair status
router.put('/:id', authMiddleware, (req, res) => {
  const {
    status, diagnosis, estimated_cost, final_cost, priority,
    assigned_to, notes, estimated_completion
  } = req.body;

  const repair = db.prepare('SELECT * FROM repairs WHERE id = ?').get(req.params.id);
  if (!repair) return res.status(404).json({ error: 'Repair not found' });

  const updates = ['updated_at = CURRENT_TIMESTAMP'];
  const params = [];

  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (diagnosis !== undefined) { updates.push('diagnosis = ?'); params.push(diagnosis); }
  if (estimated_cost !== undefined) { updates.push('estimated_cost = ?'); params.push(estimated_cost); }
  if (final_cost !== undefined) { updates.push('final_cost = ?'); params.push(final_cost); }
  if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
  if (assigned_to !== undefined) { updates.push('assigned_to = ?'); params.push(assigned_to || null); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  if (estimated_completion !== undefined) { updates.push('estimated_completion = ?'); params.push(estimated_completion || null); }

  if (status === 'completed') {
    updates.push('completed_at = CURRENT_TIMESTAMP');
  }

  params.push(req.params.id);
  try {
    db.prepare(`UPDATE repairs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true });
  } catch (err) {
    console.error('Repair update error:', err.message);
    res.status(500).json({ error: 'Failed to update repair: ' + err.message });
  }
});

// Add part to repair
router.post('/:id/parts', authMiddleware, (req, res) => {
  const { product_id, serial_item_id, quantity, cost } = req.body;

  if (!product_id) return res.status(400).json({ error: 'Product ID required' });

  const repair = db.prepare('SELECT * FROM repairs WHERE id = ?').get(req.params.id);
  if (!repair) return res.status(404).json({ error: 'Repair not found' });

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(400).json({ error: 'Product not found' });

  const id = uuidv4();
  const partCost = cost || product.cost_price;

  // Note: Stock is NOT deducted here — only when repair is fully paid (key business rule)
  // We mark is_deducted = 0
  db.prepare('INSERT INTO repair_parts (id, repair_id, product_id, serial_item_id, quantity, cost, is_deducted) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(id, req.params.id, product_id, serial_item_id || null, quantity || 1, partCost);

  // Reserve serialized items
  if (serial_item_id) {
    db.prepare('UPDATE serial_items SET status = ? WHERE id = ?').run('in_repair', serial_item_id);
  }

  res.status(201).json({ id });
});

// Process repair payment — THIS is when stock gets deducted
router.post('/:id/pay', authMiddleware, (req, res) => {
  const { amount, payment_method } = req.body;
  const repair = db.prepare('SELECT * FROM repairs WHERE id = ?').get(req.params.id);
  if (!repair) return res.status(404).json({ error: 'Repair not found' });

  const newAmountPaid = repair.amount_paid + (amount || repair.final_cost || repair.estimated_cost);
  const totalDue = repair.final_cost || repair.estimated_cost;
  const fullyPaid = newAmountPaid >= totalDue;

  db.prepare('UPDATE repairs SET amount_paid = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newAmountPaid, fullyPaid ? 'paid' : 'partial', req.params.id);

  // KEY BUSINESS RULE: Only deduct stock when fully paid
  if (fullyPaid) {
    const parts = db.prepare('SELECT * FROM repair_parts WHERE repair_id = ? AND is_deducted = 0').all(req.params.id);

    for (const part of parts) {
      // Deduct from store inventory
      db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
        .run(part.quantity, part.product_id, repair.store_id);

      // Mark as deducted
      db.prepare('UPDATE repair_parts SET is_deducted = 1 WHERE id = ?').run(part.id);

      // Log stock movement
      db.prepare('INSERT INTO stock_movements (id, product_id, store_id, serial_item_id, movement_type, quantity, reference_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uuidv4(), part.product_id, repair.store_id, part.serial_item_id, 'repair_use', -part.quantity, repair.id, req.user.id);

      // Mark serialized items as used
      if (part.serial_item_id) {
        db.prepare('UPDATE serial_items SET status = ? WHERE id = ?').run('sold', part.serial_item_id);
      }
    }

    // Mark repair completed if not already
    if (repair.status !== 'completed' && repair.status !== 'collected') {
      db.prepare('UPDATE repairs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run('completed', req.params.id);
    }
  }

  // Create a sale record for the repair payment
  const saleId = uuidv4();
  const receiptNum = `RPR-${repair.ticket_number}`;
  db.prepare(`INSERT INTO sales (id, receipt_number, store_id, user_id, customer_id, subtotal, total, payment_method, payment_status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(saleId, receiptNum, repair.store_id, req.user.id, repair.customer_id, amount, amount,
      payment_method || 'cash', fullyPaid ? 'completed' : 'partial', `Repair payment: ${repair.ticket_number}`);

  res.json({
    success: true,
    amount_paid: newAmountPaid,
    fully_paid: fullyPaid,
    receipt_number: receiptNum
  });
});

module.exports = router;
