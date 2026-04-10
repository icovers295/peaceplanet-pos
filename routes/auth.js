const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { generateToken, authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const user = db.prepare(`
    SELECT u.*, GROUP_CONCAT(usa.store_id) as accessible_stores
    FROM users u
    LEFT JOIN user_store_access usa ON u.id = usa.user_id
    WHERE u.email = ? AND u.is_active = 1
    GROUP BY u.id
  `).get(email.toLowerCase().trim());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = generateToken(user);
  const stores = db.prepare(`
    SELECT s.* FROM stores s
    JOIN user_store_access usa ON s.id = usa.store_id
    WHERE usa.user_id = ?
  `).all(user.id);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      store_id: user.store_id,
      stores
    }
  });
});

// Get current user
router.get('/me', authMiddleware, (req, res) => {
  const stores = db.prepare(`
    SELECT s.* FROM stores s
    JOIN user_store_access usa ON s.id = usa.store_id
    WHERE usa.user_id = ?
  `).all(req.user.id);

  res.json({
    id: req.user.id,
    email: req.user.email,
    first_name: req.user.first_name,
    last_name: req.user.last_name,
    role: req.user.role,
    store_id: req.user.store_id,
    stores
  });
});

// Create user (admin only)
router.post('/users', authMiddleware, requireRole('admin'), (req, res) => {
  const { email, password, first_name, last_name, role, store_id, store_ids } = req.body;

  if (!email || !password || !first_name) {
    return res.status(400).json({ error: 'Email, password, and first name required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) {
    return res.status(400).json({ error: 'Email already in use' });
  }

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);

  db.prepare('INSERT INTO users (id, email, password_hash, first_name, last_name, role, store_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, email.toLowerCase().trim(), hash, first_name, last_name || '', role || 'cashier', store_id || null);

  // Grant store access
  const accessStores = store_ids || (store_id ? [store_id] : []);
  const insertAccess = db.prepare('INSERT INTO user_store_access (user_id, store_id) VALUES (?, ?)');
  for (const sid of accessStores) {
    insertAccess.run(id, sid);
  }

  res.status(201).json({ id, email, first_name, last_name, role });
});

// List users (admin/manager)
router.get('/users', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.store_id, u.is_active, u.created_at,
           s.name as store_name
    FROM users u
    LEFT JOIN stores s ON u.store_id = s.id
    ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// Update user
router.put('/users/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const { first_name, last_name, role, store_id, is_active, store_ids, password } = req.body;

  const updates = [];
  const params = [];

  if (first_name !== undefined) { updates.push('first_name = ?'); params.push(first_name); }
  if (last_name !== undefined) { updates.push('last_name = ?'); params.push(last_name); }
  if (role !== undefined) { updates.push('role = ?'); params.push(role); }
  if (store_id !== undefined) { updates.push('store_id = ?'); params.push(store_id); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
  if (password) { updates.push('password_hash = ?'); params.push(bcrypt.hashSync(password, 10)); }

  if (updates.length > 0) {
    params.push(req.params.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  if (store_ids) {
    db.prepare('DELETE FROM user_store_access WHERE user_id = ?').run(req.params.id);
    const insertAccess = db.prepare('INSERT INTO user_store_access (user_id, store_id) VALUES (?, ?)');
    for (const sid of store_ids) {
      insertAccess.run(req.params.id, sid);
    }
  }

  res.json({ success: true });
});

module.exports = router;
