const jwt = require('jsonwebtoken');
const { db } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'peaceplanet-pos-secret-change-in-production';
const JWT_EXPIRY = '12h';

/*
  ROLE PERMISSIONS:
  ─────────────────
  admin    → Full access. Sees all stores including Main (back office).
             Sees cost prices, suppliers, purchase orders. Can manage staff.
  manager  → Can adjust stock, process refunds, view reports.
             CANNOT see cost prices, suppliers, or Main store.
  cashier  → POS and repairs only. Cannot adjust stock, refund, or see reports.
             CANNOT see cost prices, suppliers, or Main store.
*/

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, store_id: user.store_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = db.prepare(`
      SELECT u.*, GROUP_CONCAT(usa.store_id) as accessible_stores
      FROM users u
      LEFT JOIN user_store_access usa ON u.id = usa.user_id
      WHERE u.id = ? AND u.is_active = 1
      GROUP BY u.id
    `).get(decoded.id);

    if (!user) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = {
      ...user,
      accessible_stores: user.accessible_stores ? user.accessible_stores.split(',') : [],
      canSeeCostPrices: user.role === 'admin',
      canSeeMainStore: user.role === 'admin',
      canManageStock: user.role === 'admin' || user.role === 'manager',
      canRefund: user.role === 'admin' || user.role === 'manager',
      canViewReports: user.role === 'admin' || user.role === 'manager',
      canManageStaff: user.role === 'admin',
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function requireStoreAccess(req, res, next) {
  const storeId = req.params.storeId || req.body.store_id || req.query.store_id;
  if (!storeId) return next();

  // Non-admins cannot access Main store
  if (!req.user.canSeeMainStore) {
    const store = db.prepare('SELECT is_main FROM stores WHERE id = ?').get(storeId);
    if (store && store.is_main) {
      return res.status(403).json({ error: 'No access to this store' });
    }
  }

  if (req.user.role === 'admin' || req.user.accessible_stores.includes(storeId)) {
    return next();
  }
  return res.status(403).json({ error: 'No access to this store' });
}

// Middleware to strip cost prices from product responses for non-admin users
function stripSensitiveData(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    if (!req.user || req.user.canSeeCostPrices) {
      return originalJson(data);
    }
    // Strip cost_price and supplier info from responses
    const cleaned = stripCosts(data);
    return originalJson(cleaned);
  };
  next();
}

function stripCosts(data) {
  if (Array.isArray(data)) {
    return data.map(item => stripCosts(item));
  }
  if (data && typeof data === 'object') {
    const cleaned = { ...data };
    if ('cost_price' in cleaned) cleaned.cost_price = null;
    if ('cost_per_unit' in cleaned) cleaned.cost_per_unit = null;
    if ('supplier_name' in cleaned) cleaned.supplier_name = null;
    if ('supplier_contact' in cleaned) cleaned.supplier_contact = null;
    if ('cost' in cleaned && cleaned.product_id) cleaned.cost = null; // repair parts cost
    // Recursively clean nested objects and arrays
    if (cleaned.products) cleaned.products = stripCosts(cleaned.products);
    if (cleaned.items) cleaned.items = stripCosts(cleaned.items);
    if (cleaned.parts) cleaned.parts = stripCosts(cleaned.parts);
    if (cleaned.inventory) cleaned.inventory = stripCosts(cleaned.inventory);
    if (cleaned.serial_items) cleaned.serial_items = stripCosts(cleaned.serial_items);
    return cleaned;
  }
  return data;
}

module.exports = { generateToken, authMiddleware, requireRole, requireStoreAccess, stripSensitiveData, JWT_SECRET };
