const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Smart search: abbreviation expansion + fuzzy word matching ──
const SEARCH_ALIASES = {
  // Phone brands - single letter shortcuts
  'f': 'iphone', 'ip': 'iphone', 'iph': 'iphone',
  's': 'samsung', 'sam': 'samsung', 'sg': 'samsung',
  'h': 'huawei', 'hw': 'huawei', 'hua': 'huawei',
  'g': 'google', 'goo': 'google',
  'p': 'pixel',
  'o': 'oppo',
  'x': 'xiaomi', 'xi': 'xiaomi', 'xia': 'xiaomi', 'mi': 'xiaomi',
  'on': 'oneplus', '1+': 'oneplus',
  'n': 'nokia', 'nok': 'nokia',
  'mo': 'motorola', 'moto': 'motorola',
  'lg': 'lg',
  'so': 'sony',
  // Common product types
  'scr': 'screen', 'scrn': 'screen',
  'lcd': 'lcd',
  'batt': 'battery', 'bat': 'battery',
  'chrg': 'charger', 'chg': 'charger',
  'cbl': 'cable',
  'cse': 'case', 'cvr': 'cover',
  'prt': 'protector', 'tp': 'tempered',
  'cam': 'camera',
  'spk': 'speaker', 'spkr': 'speaker',
  'btn': 'button',
  'flx': 'flex',
  'con': 'connector', 'conn': 'connector',
  'pwr': 'power',
  'vol': 'volume',
  'fpc': 'fpc',
  // Model shortcuts
  'pro': 'pro', 'max': 'max', 'plus': 'plus', 'ultra': 'ultra',
  'mini': 'mini', 'se': 'se', 'lite': 'lite',
  // Galaxy shortcuts
  'a': 'a', // Samsung Galaxy A series
};

function expandSearch(raw) {
  if (!raw) return '';
  const words = raw.trim().toLowerCase().split(/\s+/);
  const expanded = words.map(w => SEARCH_ALIASES[w] || w);
  return expanded;
}

// List products with inventory for a store
router.get('/', authMiddleware, (req, res) => {
  const { store_id, category_id, search, low_stock, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let where = ['p.is_active = 1'];
  let params = [];

  if (category_id) {
    where.push('p.category_id = ?');
    params.push(category_id);
  }
  if (search) {
    // Smart search: expand abbreviations, then match each word against name/SKU/category
    // For short numeric terms (model numbers like "15", "14"), only match against name & category — not SKU
    // This prevents barcode/SKU numbers from polluting model-number searches
    // If the entire search looks like a barcode/SKU (long number or starts with letters+digits), search SKU too
    const searchWords = expandSearch(search);
    const isFullSKU = searchWords.length === 1 && /^[a-z0-9-]{5,}$/i.test(searchWords[0]);
    const wordConditions = searchWords.map(word => {
      const isShortNumber = /^\d{1,4}$/.test(word);
      if (isShortNumber && !isFullSKU) {
        // Model numbers: only search name and category, not SKU
        return '(LOWER(p.name) LIKE ? OR LOWER(COALESCE(c.name, \'\')) LIKE ?)';
      }
      return '(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(COALESCE(c.name, \'\')) LIKE ?)';
    });
    where.push('(' + wordConditions.join(' AND ') + ')');
    for (const word of searchWords) {
      const isShortNumber = /^\d{1,4}$/.test(word);
      if (isShortNumber && !isFullSKU) {
        params.push(`%${word}%`, `%${word}%`);
      } else {
        params.push(`%${word}%`, `%${word}%`, `%${word}%`);
      }
    }
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  let query;
  if (store_id) {
    query = `
      SELECT p.*, c.name as category_name, COALESCE(i.quantity, 0) as stock_quantity, i.low_stock_threshold
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN inventory i ON p.id = i.product_id AND i.store_id = ?
      ${whereClause}
      ${low_stock ? 'AND COALESCE(i.quantity, 0) <= COALESCE(i.low_stock_threshold, 5)' : ''}
      ORDER BY p.sell_price ASC, p.name
      LIMIT ? OFFSET ?
    `;
    params = [store_id, ...params, parseInt(limit), offset];
  } else {
    query = `
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${whereClause}
      ORDER BY p.sell_price ASC, p.name
      LIMIT ? OFFSET ?
    `;
    params = [...params, parseInt(limit), offset];
  }

  const products = db.prepare(query).all(...params);

  // Get total count (must include category join for search to work)
  const countQuery = store_id
    ? `SELECT COUNT(*) as total FROM products p LEFT JOIN categories c ON p.category_id = c.id LEFT JOIN inventory i ON p.id = i.product_id AND i.store_id = ? ${whereClause}`
    : `SELECT COUNT(*) as total FROM products p LEFT JOIN categories c ON p.category_id = c.id ${whereClause}`;
  const countParams = store_id ? [store_id, ...params.slice(1, -2)] : params.slice(0, -2);
  const total = db.prepare(countQuery).get(...countParams);

  res.json({ products, total: total.total, page: parseInt(page), limit: parseInt(limit) });
});

// Get single product with all store inventory
router.get('/:id', authMiddleware, (req, res) => {
  const product = db.prepare(`
    SELECT p.*, c.name as category_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!product) return res.status(404).json({ error: 'Product not found' });

  const inventory = db.prepare(`
    SELECT i.*, s.name as store_name
    FROM inventory i
    JOIN stores s ON i.store_id = s.id
    WHERE i.product_id = ?
  `).all(req.params.id);

  const serialItems = product.is_serialized
    ? db.prepare('SELECT * FROM serial_items WHERE product_id = ? ORDER BY created_at DESC').all(req.params.id)
    : [];

  res.json({ ...product, inventory, serial_items: serialItems });
});

// Create product
router.post('/', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { sku, name, description, category_id, cost_price, sell_price, is_serialized } = req.body;

  if (!name) return res.status(400).json({ error: 'Product name required' });

  if (sku) {
    const existing = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
    if (existing) return res.status(400).json({ error: 'SKU already exists' });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO products (id, sku, name, description, category_id, cost_price, sell_price, is_serialized) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, sku || `PP-${Date.now()}`, name, description || '', category_id || null, cost_price || 0, sell_price || 0, is_serialized ? 1 : 0);

  // Create inventory entries for all stores
  const stores = db.prepare('SELECT id FROM stores').all();
  const insertInv = db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, 0)');
  for (const s of stores) {
    insertInv.run(uuidv4(), id, s.id);
  }

  res.status(201).json({ id, sku, name });
});

// Update product
router.put('/:id', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { sku, name, description, category_id, cost_price, sell_price, is_serialized, is_active } = req.body;

  const updates = [];
  const params = [];

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (sku !== undefined) { updates.push('sku = ?'); params.push(sku); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (category_id !== undefined) { updates.push('category_id = ?'); params.push(category_id); }
  if (cost_price !== undefined) { updates.push('cost_price = ?'); params.push(cost_price); }
  if (sell_price !== undefined) { updates.push('sell_price = ?'); params.push(sell_price); }
  if (is_serialized !== undefined) { updates.push('is_serialized = ?'); params.push(is_serialized ? 1 : 0); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id);
    db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  res.json({ success: true });
});

// Adjust stock for a product at a store
router.post('/:id/stock', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { store_id, quantity, adjustment_type, notes } = req.body;
  // adjustment_type: 'set', 'add', 'remove'

  if (!store_id) return res.status(400).json({ error: 'Store ID required' });

  const inv = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(req.params.id, store_id);

  let newQty;
  if (adjustment_type === 'set') {
    newQty = quantity;
  } else if (adjustment_type === 'remove') {
    newQty = (inv ? inv.quantity : 0) - Math.abs(quantity);
  } else {
    newQty = (inv ? inv.quantity : 0) + Math.abs(quantity);
  }

  if (newQty < 0) newQty = 0;

  if (inv) {
    db.prepare('UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newQty, inv.id);
  } else {
    db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, ?)').run(uuidv4(), req.params.id, store_id, newQty);
  }

  // Log the movement
  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), req.params.id, store_id, 'adjustment', quantity, notes || `Stock ${adjustment_type}: ${quantity}`, req.user.id);

  res.json({ success: true, new_quantity: newQty });
});

// Add serial item
router.post('/:id/serial', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { store_id, serial_number, imei, cost_price, condition, notes } = req.body;

  if (!serial_number && !imei) return res.status(400).json({ error: 'Serial number or IMEI required' });

  const id = uuidv4();
  db.prepare('INSERT INTO serial_items (id, product_id, store_id, serial_number, imei, cost_price, condition, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, store_id, serial_number || imei, imei || null, cost_price || 0, condition || 'new', notes || '');

  // Update inventory count
  db.prepare('UPDATE inventory SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
    .run(req.params.id, store_id);

  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, serial_item_id, movement_type, quantity, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), req.params.id, store_id, id, 'adjustment', 1, `Added serial: ${serial_number || imei}`, req.user.id);

  res.status(201).json({ id, serial_number, imei });
});

// Transfer stock between stores
router.post('/transfer', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { product_id, from_store_id, to_store_id, quantity, notes } = req.body;

  if (!product_id || !from_store_id || !to_store_id || !quantity) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const fromInv = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(product_id, from_store_id);
  if (!fromInv || fromInv.quantity < quantity) {
    return res.status(400).json({ error: 'Insufficient stock at source store' });
  }

  // Deduct from source
  db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
    .run(quantity, product_id, from_store_id);

  // Add to destination
  const toInv = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(product_id, to_store_id);
  if (toInv) {
    db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
      .run(quantity, product_id, to_store_id);
  } else {
    db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), product_id, to_store_id, quantity);
  }

  // Log transfer
  const transferId = uuidv4();
  db.prepare('INSERT INTO stock_transfers (id, from_store_id, to_store_id, product_id, quantity, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(transferId, from_store_id, to_store_id, product_id, quantity, 'received', notes || '', req.user.id);

  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, reference_id, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), product_id, from_store_id, 'transfer', -quantity, transferId, `Transfer out to store`, req.user.id);
  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, reference_id, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), product_id, to_store_id, 'transfer', quantity, transferId, `Transfer in from store`, req.user.id);

  res.json({ success: true, transfer_id: transferId });
});

// Get categories
router.get('/categories/list', authMiddleware, (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json(categories);
});

// Create category
router.post('/categories', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO categories (id, name, description) VALUES (?, ?, ?)').run(id, name, description || '');
  res.status(201).json({ id, name });
});


// Bulk import products + per-store stock (admin only)
router.post('/bulk-import', authMiddleware, requireRole('admin'), (req, res) => {
  const { products = [], stock = {} } = req.body;
  if (!Array.isArray(products)) return res.status(400).json({ error: 'products must be array' });

  const stores = db.prepare('SELECT id FROM stores').all();
  const storeIds = stores.map(s => s.id);

  const catRows = db.prepare('SELECT id, name FROM categories').all();
  const catMap = new Map(catRows.map(c => [c.name.toLowerCase(), c.id]));
  const insertCat = db.prepare('INSERT INTO categories (id, name, description) VALUES (?, ?, ?)');

  const existingSkus = new Map(db.prepare('SELECT id, sku FROM products').all().map(p => [p.sku, p.id]));
  const insertProd = db.prepare('INSERT INTO products (id, sku, name, description, category_id, cost_price, sell_price, is_serialized) VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
  const updateProd = db.prepare('UPDATE products SET name=?, category_id=?, cost_price=?, sell_price=? WHERE id=?');
  const insertInv = db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, 0)');
  const existingInv = db.prepare('SELECT product_id, store_id FROM inventory');
  const updateInv = db.prepare('UPDATE inventory SET quantity = ? WHERE product_id = ? AND store_id = ?');

  const stats = { categories_created: 0, products_created: 0, products_updated: 0, inventory_set: 0 };

  const tx = db.transaction(() => {
    for (const p of products) {
      const key = (p.category || '').toLowerCase();
      if (key && !catMap.has(key)) {
        const cid = uuidv4();
        insertCat.run(cid, p.category, '');
        catMap.set(key, cid);
        stats.categories_created++;
      }
    }
    const skuToId = new Map();
    for (const p of products) {
      const catId = p.category ? catMap.get(p.category.toLowerCase()) : null;
      if (existingSkus.has(p.sku)) {
        const id = existingSkus.get(p.sku);
        updateProd.run(p.name, catId, p.cost_price || 0, p.sell_price || 0, id);
        skuToId.set(p.sku, id);
        stats.products_updated++;
      } else {
        const id = uuidv4();
        insertProd.run(id, p.sku, p.name, '', catId, p.cost_price || 0, p.sell_price || 0);
        skuToId.set(p.sku, id);
        stats.products_created++;
      }
    }
    const invSet = new Set(existingInv.all().map(r => r.product_id + '|' + r.store_id));
    for (const pid of skuToId.values()) {
      for (const sid of storeIds) {
        if (!invSet.has(pid + '|' + sid)) {
          insertInv.run(uuidv4(), pid, sid);
          invSet.add(pid + '|' + sid);
        }
      }
    }
    for (const [sku, perStore] of Object.entries(stock)) {
      const pid = skuToId.get(sku);
      if (!pid) continue;
      for (const [sid, qty] of Object.entries(perStore)) {
        updateInv.run(qty, pid, sid);
        stats.inventory_set++;
      }
    }
  });

  try {
    tx();
    res.json({ success: true, ...stats });
  } catch (e) {
    console.error('Bulk import error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Smart search: abbreviation expansion + fuzzy word matching ──
const SEARCH_ALIASES = {
  // Phone brands - single letter shortcuts
  'f': 'iphone', 'ip': 'iphone', 'iph': 'iphone',
  's': 'samsung', 'sam': 'samsung', 'sg': 'samsung',
  'h': 'huawei', 'hw': 'huawei', 'hua': 'huawei',
  'g': 'google', 'goo': 'google',
  'p': 'pixel',
  'o': 'oppo',
  'x': 'xiaomi', 'xi': 'xiaomi', 'xia': 'xiaomi', 'mi': 'xiaomi',
  'on': 'oneplus', '1+': 'oneplus',
  'n': 'nokia', 'nok': 'nokia',
  'mo': 'motorola', 'moto': 'motorola',
  'lg': 'lg',
  'so': 'sony',
  // Common product types
  'scr': 'screen', 'scrn': 'screen',
  'lcd': 'lcd',
  'batt': 'battery', 'bat': 'battery',
  'chrg': 'charger', 'chg': 'charger',
  'cbl': 'cable',
  'cse': 'case', 'cvr': 'cover',
  'prt': 'protector', 'tp': 'tempered',
  'cam': 'camera',
  'spk': 'speaker', 'spkr': 'speaker',
  'btn': 'button',
  'flx': 'flex',
  'con': 'connector', 'conn': 'connector',
  'pwr': 'power',
  'vol': 'volume',
  'fpc': 'fpc',
  // Model shortcuts
  'pro': 'pro', 'max': 'max', 'plus': 'plus', 'ultra': 'ultra',
  'mini': 'mini', 'se': 'se', 'lite': 'lite',
  // Galaxy shortcuts
  'a': 'a', // Samsung Galaxy A series
};

function expandSearch(raw) {
  if (!raw) return '';
  const words = raw.trim().toLowerCase().split(/\s+/);
  const expanded = words.map(w => SEARCH_ALIASES[w] || w);
  return expanded;
}

// List products with inventory for a store
router.get('/', authMiddleware, (req, res) => {
  const { store_id, category_id, search, low_stock, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let where = ['p.is_active = 1'];
  let params = [];

  if (category_id) {
    where.push('p.category_id = ?');
    params.push(category_id);
  }
  if (search) {
    // Smart search: expand abbreviations, then match each word against name/SKU/category
    // For short numeric terms (model numbers like "15", "14"), only match against name & category — not SKU
    // This prevents barcode/SKU numbers from polluting model-number searches
    // If the entire search looks like a barcode/SKU (long number or starts with letters+digits), search SKU too
    const searchWords = expandSearch(search);
    const isFullSKU = searchWords.length === 1 && /^[a-z0-9-]{5,}$/i.test(searchWords[0]);
    const wordConditions = searchWords.map(word => {
      const isShortNumber = /^\d{1,4}$/.test(word);
      if (isShortNumber && !isFullSKU) {
        // Model numbers: only search name and category, not SKU
        return '(LOWER(p.name) LIKE ? OR LOWER(COALESCE(c.name, \'\')) LIKE ?)';
      }
      return '(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(COALESCE(c.name, \'\')) LIKE ?)';
    });
    where.push('(' + wordConditions.join(' AND ') + ')');
    for (const word of searchWords) {
      const isShortNumber = /^\d{1,4}$/.test(word);
      if (isShortNumber && !isFullSKU) {
        params.push(`%${word}%`, `%${word}%`);
      } else {
        params.push(`%${word}%`, `%${word}%`, `%${word}%`);
      }
    }
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  let query;
  if (store_id) {
    query = `
      SELECT p.*, c.name as category_name, COALESCE(i.quantity, 0) as stock_quantity, i.low_stock_threshold
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN inventory i ON p.id = i.product_id AND i.store_id = ?
      ${whereClause}
      ${low_stock ? 'AND COALESCE(i.quantity, 0) <= COALESCE(i.low_stock_threshold, 5)' : ''}
      ORDER BY p.sell_price ASC, p.name
      LIMIT ? OFFSET ?
    `;
    params = [store_id, ...params, parseInt(limit), offset];
  } else {
    query = `
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${whereClause}
      ORDER BY p.sell_price ASC, p.name
      LIMIT ? OFFSET ?
    `;
    params = [...params, parseInt(limit), offset];
  }

  const products = db.prepare(query).all(...params);

  // Get total count (must include category join for search to work)
  const countQuery = store_id
    ? `SELECT COUNT(*) as total FROM products p LEFT JOIN categories c ON p.category_id = c.id LEFT JOIN inventory i ON p.id = i.product_id AND i.store_id = ? ${whereClause}`
    : `SELECT COUNT(*) as total FROM products p LEFT JOIN categories c ON p.category_id = c.id ${whereClause}`;
  const countParams = store_id ? [store_id, ...params.slice(1, -2)] : params.slice(0, -2);
  const total = db.prepare(countQuery).get(...countParams);

  res.json({ products, total: total.total, page: parseInt(page), limit: parseInt(limit) });
});

// Get single product with all store inventory
router.get('/:id', authMiddleware, (req, res) => {
  const product = db.prepare(`
    SELECT p.*, c.name as category_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!product) return res.status(404).json({ error: 'Product not found' });

  const inventory = db.prepare(`
    SELECT i.*, s.name as store_name
    FROM inventory i
    JOIN stores s ON i.store_id = s.id
    WHERE i.product_id = ?
  `).all(req.params.id);

  const serialItems = product.is_serialized
    ? db.prepare('SELECT * FROM serial_items WHERE product_id = ? ORDER BY created_at DESC').all(req.params.id)
    : [];

  res.json({ ...product, inventory, serial_items: serialItems });
});

// Create product
router.post('/', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { sku, name, description, category_id, cost_price, sell_price, is_serialized } = req.body;

  if (!name) return res.status(400).json({ error: 'Product name required' });

  if (sku) {
    const existing = db.prepare('SELECT id FROM products WHERE sku = ?').get(sku);
    if (existing) return res.status(400).json({ error: 'SKU already exists' });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO products (id, sku, name, description, category_id, cost_price, sell_price, is_serialized) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, sku || `PP-${Date.now()}`, name, description || '', category_id || null, cost_price || 0, sell_price || 0, is_serialized ? 1 : 0);

  // Create inventory entries for all stores
  const stores = db.prepare('SELECT id FROM stores').all();
  const insertInv = db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, 0)');
  for (const s of stores) {
    insertInv.run(uuidv4(), id, s.id);
  }

  res.status(201).json({ id, sku, name });
});

// Update product
router.put('/:id', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { sku, name, description, category_id, cost_price, sell_price, is_serialized, is_active } = req.body;

  const updates = [];
  const params = [];

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (sku !== undefined) { updates.push('sku = ?'); params.push(sku); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (category_id !== undefined) { updates.push('category_id = ?'); params.push(category_id); }
  if (cost_price !== undefined) { updates.push('cost_price = ?'); params.push(cost_price); }
  if (sell_price !== undefined) { updates.push('sell_price = ?'); params.push(sell_price); }
  if (is_serialized !== undefined) { updates.push('is_serialized = ?'); params.push(is_serialized ? 1 : 0); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id);
    db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  res.json({ success: true });
});

// Adjust stock for a product at a store
router.post('/:id/stock', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { store_id, quantity, adjustment_type, notes } = req.body;
  // adjustment_type: 'set', 'add', 'remove'

  if (!store_id) return res.status(400).json({ error: 'Store ID required' });

  const inv = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(req.params.id, store_id);

  let newQty;
  if (adjustment_type === 'set') {
    newQty = quantity;
  } else if (adjustment_type === 'remove') {
    newQty = (inv ? inv.quantity : 0) - Math.abs(quantity);
  } else {
    newQty = (inv ? inv.quantity : 0) + Math.abs(quantity);
  }

  if (newQty < 0) newQty = 0;

  if (inv) {
    db.prepare('UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newQty, inv.id);
  } else {
    db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, ?)').run(uuidv4(), req.params.id, store_id, newQty);
  }

  // Log the movement
  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), req.params.id, store_id, 'adjustment', quantity, notes || `Stock ${adjustment_type}: ${quantity}`, req.user.id);

  res.json({ success: true, new_quantity: newQty });
});

// Add serial item
router.post('/:id/serial', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { store_id, serial_number, imei, cost_price, condition, notes } = req.body;

  if (!serial_number && !imei) return res.status(400).json({ error: 'Serial number or IMEI required' });

  const id = uuidv4();
  db.prepare('INSERT INTO serial_items (id, product_id, store_id, serial_number, imei, cost_price, condition, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, store_id, serial_number || imei, imei || null, cost_price || 0, condition || 'new', notes || '');

  // Update inventory count
  db.prepare('UPDATE inventory SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
    .run(req.params.id, store_id);

  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, serial_item_id, movement_type, quantity, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), req.params.id, store_id, id, 'adjustment', 1, `Added serial: ${serial_number || imei}`, req.user.id);

  res.status(201).json({ id, serial_number, imei });
});

// Transfer stock between stores
router.post('/transfer', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { product_id, from_store_id, to_store_id, quantity, notes } = req.body;

  if (!product_id || !from_store_id || !to_store_id || !quantity) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const fromInv = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(product_id, from_store_id);
  if (!fromInv || fromInv.quantity < quantity) {
    return res.status(400).json({ error: 'Insufficient stock at source store' });
  }

  // Deduct from source
  db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
    .run(quantity, product_id, from_store_id);

  // Add to destination
  const toInv = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(product_id, to_store_id);
  if (toInv) {
    db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
      .run(quantity, product_id, to_store_id);
  } else {
    db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), product_id, to_store_id, quantity);
  }

  // Log transfer
  const transferId = uuidv4();
  db.prepare('INSERT INTO stock_transfers (id, from_store_id, to_store_id, product_id, quantity, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(transferId, from_store_id, to_store_id, product_id, quantity, 'received', notes || '', req.user.id);

  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, reference_id, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), product_id, from_store_id, 'transfer', -quantity, transferId, `Transfer out to store`, req.user.id);
  db.prepare('INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, reference_id, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), product_id, to_store_id, 'transfer', quantity, transferId, `Transfer in from store`, req.user.id);

  res.json({ success: true, transfer_id: transferId });
});

// Get categories
router.get('/categories/list', authMiddleware, (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json(categories);
});

// Create category
router.post('/categories', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO categories (id, name, description) VALUES (?, ?, ?)').run(id, name, description || '');
  res.status(201).json({ id, name });
});

module.exports = router;
