const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'peaceplanet.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initialize() {
  db.exec(`
    -- Stores
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      email TEXT,
      is_main INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Users / Staff
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier', -- admin, manager, cashier
      store_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id)
    );

    -- User store access (which stores can this user access)
    CREATE TABLE IF NOT EXISTS user_store_access (
      user_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      PRIMARY KEY (user_id, store_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (store_id) REFERENCES stores(id)
    );

    -- Categories
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Products (shared catalog across stores)
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      category_id TEXT,
      cost_price REAL DEFAULT 0,
      sell_price REAL DEFAULT 0,
      is_serialized INTEGER DEFAULT 0, -- tracks IMEI/serial numbers
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    -- Inventory per store
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 0,
      low_stock_threshold INTEGER DEFAULT 5,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(product_id, store_id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (store_id) REFERENCES stores(id)
    );

    -- Serialized items (IMEI / serial number tracking)
    CREATE TABLE IF NOT EXISTS serial_items (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      serial_number TEXT NOT NULL,
      imei TEXT,
      status TEXT DEFAULT 'in_stock', -- in_stock, sold, in_repair, reserved
      cost_price REAL DEFAULT 0,
      condition TEXT DEFAULT 'new', -- new, refurbished, used
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (store_id) REFERENCES stores(id)
    );

    -- Customers
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sales / Transactions
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      receipt_number TEXT UNIQUE NOT NULL,
      store_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      customer_id TEXT,
      subtotal REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      total REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'cash', -- cash, card, mixed
      payment_status TEXT DEFAULT 'completed', -- completed, partial, refunded
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    -- Sale items
    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      serial_item_id TEXT,
      quantity INTEGER DEFAULT 1,
      unit_price REAL NOT NULL,
      discount REAL DEFAULT 0,
      total REAL NOT NULL,
      refunded INTEGER DEFAULT 0,
      FOREIGN KEY (sale_id) REFERENCES sales(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (serial_item_id) REFERENCES serial_items(id)
    );

    -- Repairs
    CREATE TABLE IF NOT EXISTS repairs (
      id TEXT PRIMARY KEY,
      ticket_number TEXT UNIQUE NOT NULL,
      store_id TEXT NOT NULL,
      customer_id TEXT,
      assigned_to TEXT,
      device_type TEXT,
      device_brand TEXT,
      device_model TEXT,
      imei TEXT,
      issue_description TEXT NOT NULL,
      diagnosis TEXT,
      status TEXT DEFAULT 'checked_in',
      -- checked_in, diagnosing, awaiting_parts, in_repair, ready, completed, collected
      estimated_cost REAL DEFAULT 0,
      final_cost REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'unpaid', -- unpaid, partial, paid
      amount_paid REAL DEFAULT 0,
      priority TEXT DEFAULT 'normal', -- low, normal, high, urgent
      estimated_completion DATETIME,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (store_id) REFERENCES stores(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );

    -- Repair parts used (links repair to inventory)
    CREATE TABLE IF NOT EXISTS repair_parts (
      id TEXT PRIMARY KEY,
      repair_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      serial_item_id TEXT,
      quantity INTEGER DEFAULT 1,
      cost REAL DEFAULT 0,
      is_deducted INTEGER DEFAULT 0, -- stock only deducted when repair is fully paid
      FOREIGN KEY (repair_id) REFERENCES repairs(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- Purchase Orders (for restocking)
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      po_number TEXT UNIQUE NOT NULL,
      store_id TEXT NOT NULL,
      supplier_name TEXT,
      supplier_contact TEXT,
      invoice_reference TEXT,
      status TEXT DEFAULT 'draft', -- draft, ordered, partial, received, cancelled
      total REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      received_at DATETIME,
      received_by TEXT,
      FOREIGN KEY (store_id) REFERENCES stores(id),
      FOREIGN KEY (received_by) REFERENCES users(id)
    );

    -- Purchase order items
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity_ordered INTEGER DEFAULT 0,
      quantity_received INTEGER DEFAULT 0,
      cost_per_unit REAL DEFAULT 0,
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- Stock movements log
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      serial_item_id TEXT,
      movement_type TEXT NOT NULL, -- sale, return, repair_use, purchase_receive, adjustment, transfer
      quantity INTEGER NOT NULL,
      reference_id TEXT, -- sale_id, repair_id, po_id, etc.
      notes TEXT,
      user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (store_id) REFERENCES stores(id)
    );

    -- Stock transfers between stores
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id TEXT PRIMARY KEY,
      from_store_id TEXT NOT NULL,
      to_store_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT DEFAULT 'pending', -- pending, in_transit, received
      notes TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      received_at DATETIME,
      FOREIGN KEY (from_store_id) REFERENCES stores(id),
      FOREIGN KEY (to_store_id) REFERENCES stores(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    -- Labels queue (for printing)
    CREATE TABLE IF NOT EXISTS label_queue (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      serial_item_id TEXT,
      store_id TEXT NOT NULL,
      label_type TEXT DEFAULT 'price', -- price, barcode, shelf, demo
      quantity INTEGER DEFAULT 1,
      printed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_inventory_store ON inventory(store_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_product ON inventory(product_id);
    CREATE INDEX IF NOT EXISTS idx_sales_store ON sales(store_id);
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_repairs_store ON repairs(store_id);
    CREATE INDEX IF NOT EXISTS idx_repairs_status ON repairs(status);
    CREATE INDEX IF NOT EXISTS idx_serial_items_serial ON serial_items(serial_number);
    CREATE INDEX IF NOT EXISTS idx_serial_items_imei ON serial_items(imei);
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
  `);

  // Migrations for existing databases
  const migrations = [
    'ALTER TABLE purchase_orders ADD COLUMN invoice_reference TEXT',
    'ALTER TABLE purchase_orders ADD COLUMN received_by TEXT REFERENCES users(id)',
    'ALTER TABLE sale_items ADD COLUMN refunded INTEGER DEFAULT 0',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch(e) { /* column already exists */ }
  }

  // Seed default data
  seedDefaultData();
}

function seedDefaultData() {
  const storeCount = db.prepare('SELECT COUNT(*) as count FROM stores').get();
  if (storeCount.count > 0) return;

  // Create stores
  const stores = [
    { id: uuidv4(), name: 'PeacePlanet - Main', address: 'Main Street, Northern Ireland', is_main: 1 },
    { id: uuidv4(), name: 'PeacePlanet - Dungannon', address: 'Dungannon, Northern Ireland', is_main: 0 },
    { id: uuidv4(), name: 'PeacePlanet - Cookstown', address: 'Cookstown, Northern Ireland', is_main: 0 },
    { id: uuidv4(), name: 'PeacePlanet - Omagh', address: 'Omagh, Northern Ireland', is_main: 0 },
  ];

  const insertStore = db.prepare('INSERT INTO stores (id, name, address, is_main) VALUES (?, ?, ?, ?)');
  for (const s of stores) {
    insertStore.run(s.id, s.name, s.address, s.is_main);
  }

  // Create default admin user
  const adminId = uuidv4();
  const passwordHash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (id, email, password_hash, first_name, last_name, role, store_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(adminId, 'admin@peaceplanet.com', passwordHash, 'Paul', 'Bullock', 'admin', stores[0].id);

  // Give admin access to all stores
  const insertAccess = db.prepare('INSERT INTO user_store_access (user_id, store_id) VALUES (?, ?)');
  for (const s of stores) {
    insertAccess.run(adminId, s.id);
  }

  // Create default categories
  const categories = [
    { id: uuidv4(), name: 'Phones' },
    { id: uuidv4(), name: 'Tablets' },
    { id: uuidv4(), name: 'Accessories' },
    { id: uuidv4(), name: 'Parts & Components' },
    { id: uuidv4(), name: 'Cases & Covers' },
    { id: uuidv4(), name: 'Chargers & Cables' },
    { id: uuidv4(), name: 'Screen Protectors' },
    { id: uuidv4(), name: 'Other' },
  ];

  const insertCat = db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)');
  for (const c of categories) {
    insertCat.run(c.id, c.name);
  }

  // Create some sample products
  const sampleProducts = [
    { name: 'iPhone 15 Screen (OLED)', sku: 'PRT-IP15-SCR', category: 'Parts & Components', cost: 45, sell: 89.99, serialized: 0 },
    { name: 'Samsung S24 Screen', sku: 'PRT-SS24-SCR', category: 'Parts & Components', cost: 38, sell: 79.99, serialized: 0 },
    { name: 'iPhone 15 Pro Max', sku: 'PHN-IP15PM', category: 'Phones', cost: 800, sell: 1099.99, serialized: 1 },
    { name: 'Samsung Galaxy S24 Ultra', sku: 'PHN-SS24U', category: 'Phones', cost: 750, sell: 999.99, serialized: 1 },
    { name: 'USB-C Cable 1m', sku: 'ACC-USBC-1M', category: 'Chargers & Cables', cost: 1.50, sell: 7.99, serialized: 0 },
    { name: 'Lightning Cable 1m', sku: 'ACC-LTNG-1M', category: 'Chargers & Cables', cost: 1.50, sell: 7.99, serialized: 0 },
    { name: 'Tempered Glass iPhone 15', sku: 'SP-IP15-TG', category: 'Screen Protectors', cost: 0.80, sell: 9.99, serialized: 0 },
    { name: '20W USB-C Charger', sku: 'ACC-CHG-20W', category: 'Chargers & Cables', cost: 3, sell: 14.99, serialized: 0 },
  ];

  const insertProduct = db.prepare('INSERT INTO products (id, sku, name, category_id, cost_price, sell_price, is_serialized) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertInventory = db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, ?)');

  for (const p of sampleProducts) {
    const catRow = db.prepare('SELECT id FROM categories WHERE name = ?').get(p.category);
    const prodId = uuidv4();
    insertProduct.run(prodId, p.sku, p.name, catRow ? catRow.id : null, p.cost, p.sell, p.serialized ? 1 : 0);

    // Add inventory for each store
    for (const s of stores) {
      const qty = p.serialized ? 0 : Math.floor(Math.random() * 50) + 5;
      insertInventory.run(uuidv4(), prodId, s.id, qty);
    }
  }

  console.log('✓ Database seeded with default data');
  console.log('  Default login: admin@peaceplanet.com / admin123');
}

module.exports = { db, initialize };
