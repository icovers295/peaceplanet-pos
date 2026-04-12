const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// List customers
router.get('/', authMiddleware, (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let where = '';
  let params = [];

  if (search) {
    where = 'WHERE first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ?';
    params = [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`];
  }

  const customers = db.prepare(`
    SELECT * FROM customers ${where} ORDER BY first_name LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  const total = db.prepare(`SELECT COUNT(*) as total FROM customers ${where}`).get(...params);

  res.json({ customers, total: total.total, page: parseInt(page), limit: parseInt(limit) });
});

// Get customer with history
router.get('/:id', authMiddleware, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const sales = db.prepare(`
    SELECT s.*, st.name as store_name FROM sales s
    JOIN stores st ON s.store_id = st.id
    WHERE s.customer_id = ? ORDER BY s.created_at DESC LIMIT 20
  `).all(req.params.id);

  const repairs = db.prepare(`
    SELECT r.*, st.name as store_name FROM repairs r
    JOIN stores st ON r.store_id = st.id
    WHERE r.customer_id = ? ORDER BY r.created_at DESC LIMIT 20
  `).all(req.params.id);

  res.json({ ...customer, sales, repairs });
});

// Create customer
router.post('/', authMiddleware, (req, res) => {
  const { first_name, last_name, email, phone, address, notes } = req.body;
  if (!first_name) return res.status(400).json({ error: 'First name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO customers (id, first_name, last_name, email, phone, address, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, first_name, last_name || '', email || '', phone || '', address || '', notes || '');

  res.status(201).json({ id, first_name, last_name });
});

// Update customer
router.put('/:id', authMiddleware, (req, res) => {
  const { first_name, last_name, email, phone, address, notes } = req.body;
  const updates = [];
  const params = [];

  if (first_name !== undefined) { updates.push('first_name = ?'); params.push(first_name); }
  if (last_name !== undefined) { updates.push('last_name = ?'); params.push(last_name); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email); }
  if (phone !== undefined) { updates.push('phone = ?'); params.push(phone); }
  if (address !== undefined) { updates.push('address = ?'); params.push(address); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }

  if (updates.length > 0) {
    params.push(req.params.id);
    db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  res.json({ success: true });
});

module.exports = router;
