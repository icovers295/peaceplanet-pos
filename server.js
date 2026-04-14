require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initialize, db } = require('./database');
const { authMiddleware, stripSensitiveData } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database
initialize();

// API Routes — stripSensitiveData removes cost prices for non-admins
app.use('/api/auth', require('./routes/auth'));
app.use('/api/stores', require('./routes/stores'));
app.use('/api/products', stripSensitiveData, require('./routes/products'));
app.use('/api/sales', stripSensitiveData, require('./routes/sales'));
app.use('/api/repairs', stripSensitiveData, require('./routes/repairs'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/purchase-orders', stripSensitiveData, require('./routes/purchase-orders'));
app.use('/api/stock-orders', stripSensitiveData, require('./routes/stock-orders'));
// ── User permissions endpoint (tells frontend what to show/hide) ──
app.get('/api/permissions', authMiddleware, (req, res) => {
  res.json({
    role: req.user.role,
    canSeeCostPrices: req.user.canSeeCostPrices,
    canSeeMainStore: req.user.canSeeMainStore,
    canManageStock: req.user.canManageStock,
    canRefund: req.user.canRefund,
    canViewReports: req.user.canViewReports,
    canManageStaff: req.user.canManageStaff,
  });
});

// ── Monitor Mode: Public repair status board (no auth needed) ──
app.get('/api/monitor/repairs/:storeId', (req, res) => {
  const store = db.prepare('SELECT id, name FROM stores WHERE id = ? AND is_main = 0').get(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const repairs = db.prepare(`
    SELECT r.ticket_number, r.device_brand, r.device_model, r.status, r.priority,
           SUBSTR(c.first_name, 1, 1) || '. ' || COALESCE(c.last_name, '') as customer_initial
    FROM repairs r
    LEFT JOIN customers c ON r.customer_id = c.id
    WHERE r.store_id = ? AND r.status NOT IN ('collected')
    ORDER BY
      CASE r.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
      r.created_at DESC
    LIMIT 20
  `).all(req.params.storeId);

  res.json({ store, repairs });
});

// ── Stock Transfer endpoint (improved) ──
app.get('/api/transfers', authMiddleware, (req, res) => {
  const { store_id, status } = req.query;
  let where = [];
  let params = [];

  if (store_id) {
    where.push('(st.from_store_id = ? OR st.to_store_id = ?)');
    params.push(store_id, store_id);
  }
  if (status) { where.push('st.status = ?'); params.push(status); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const transfers = db.prepare(`
    SELECT st.*, p.name as product_name, p.sku,
           fs.name as from_store_name, ts.name as to_store_name,
           u.first_name || ' ' || u.last_name as created_by_name
    FROM stock_transfers st
    JOIN products p ON st.product_id = p.id
    JOIN stores fs ON st.from_store_id = fs.id
    JOIN stores ts ON st.to_store_id = ts.id
    LEFT JOIN users u ON st.created_by = u.id
    ${whereClause}
    ORDER BY st.created_at DESC
    LIMIT 100
  `).all(...params);

  res.json(transfers);
});

// Create stock transfer
app.post('/api/transfers', authMiddleware, (req, res) => {
  const { product_id, from_store_id, to_store_id, quantity, notes } = req.body;

  if (!product_id || !from_store_id || !to_store_id || !quantity) {
    return res.status(400).json({ error: 'Product, from store, to store, and quantity are required' });
  }
  if (from_store_id === to_store_id) {
    return res.status(400).json({ error: 'From and To store must be different' });
  }
  if (quantity < 1) {
    return res.status(400).json({ error: 'Quantity must be at least 1' });
  }

  // Check product exists
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!product) return res.status(400).json({ error: 'Product not found' });

  // Check stock at source store
  const inv = db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(product_id, from_store_id);
  if (!inv || inv.quantity < quantity) {
    return res.status(400).json({ error: 'Insufficient stock. Available: ' + (inv ? inv.quantity : 0) });
  }

  const transferId = require('uuid').v4();

  // Create transfer and immediately deduct from source, add to destination
  const createTransfer = db.transaction(() => {
    db.prepare(`INSERT INTO stock_transfers (id, from_store_id, to_store_id, product_id, quantity, status, notes, created_by)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(transferId, from_store_id, to_store_id, product_id, quantity, notes || '', req.user.id);

    // Deduct from source store
    db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
      .run(quantity, product_id, from_store_id);

    // Add to destination store (upsert)
    const destInv = db.prepare('SELECT id FROM inventory WHERE product_id = ? AND store_id = ?').get(product_id, to_store_id);
    if (destInv) {
      db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
        .run(quantity, product_id, to_store_id);
    } else {
      db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, ?)')
        .run(require('uuid').v4(), product_id, to_store_id, quantity);
    }

    // Record stock movements
    db.prepare('INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, reference_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(require('uuid').v4(), product_id, from_store_id, 'transfer_out', -quantity, transferId, req.user.id);
    db.prepare('INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, reference_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(require('uuid').v4(), product_id, to_store_id, 'transfer_in', quantity, transferId, req.user.id);

    // Mark as received immediately (stock already moved)
    db.prepare('UPDATE stock_transfers SET status = ?, received_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('received', transferId);
  });

  try {
    createTransfer();
    res.status(201).json({ id: transferId, message: 'Transfer completed — stock moved' });
  } catch (err) {
    console.error('Transfer error:', err);
    res.status(500).json({ error: 'Failed to create transfer: ' + err.message });
  }
});

// Receive a pending transfer (legacy — for transfers created without immediate completion)
app.post('/api/transfers/:id/receive', authMiddleware, (req, res) => {
  const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id);
  if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
  if (transfer.status === 'received') return res.status(400).json({ error: 'Already received' });

  const receiveTransfer = db.transaction(() => {
    // Add stock to destination
    const destInv = db.prepare('SELECT id FROM inventory WHERE product_id = ? AND store_id = ?').get(transfer.product_id, transfer.to_store_id);
    if (destInv) {
      db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?')
        .run(transfer.quantity, transfer.product_id, transfer.to_store_id);
    } else {
      db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity) VALUES (?, ?, ?, ?)')
        .run(require('uuid').v4(), transfer.product_id, transfer.to_store_id, transfer.quantity);
    }

    // Record movement
    db.prepare('INSERT INTO stock_movements (id, product_id, store_id, movement_type, quantity, reference_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(require('uuid').v4(), transfer.product_id, transfer.to_store_id, 'transfer_in', transfer.quantity, transfer.id, req.user.id);

    // Update status
    db.prepare('UPDATE stock_transfers SET status = ?, received_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('received', transfer.id);
  });

  try {
    receiveTransfer();
    res.json({ success: true, message: 'Transfer received — stock updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to receive transfer: ' + err.message });
  }
});

// Receipt printing
app.post('/api/print/receipt', authMiddleware, (req, res) => {
  const { sale } = req.body;
  if (!sale) return res.status(400).json({ error: 'Sale data required' });

  const itemsHtml = (sale.items || []).map(item => `
    <tr>
      <td>${item.product_name || item.name}</td>
      <td style="text-align:center">${item.quantity}</td>
      <td style="text-align:right">£${(item.unit_price || 0).toFixed(2)}</td>
      <td style="text-align:right">£${(item.total || 0).toFixed(2)}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: 'Courier New', monospace; width: 280px; margin: 0 auto; font-size: 12px; }
  .center { text-align: center; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; }
  .line { border-top: 1px dashed #000; margin: 5px 0; }
  @media print { body { margin: 0; } }
</style></head><body>
  <div class="center"><strong>PEACEPLANET</strong><br>${sale.store_name || ''}<br><br></div>
  <div>Receipt: ${sale.receipt_number}<br>Date: ${new Date(sale.created_at || Date.now()).toLocaleString('en-GB')}<br>Cashier: ${sale.cashier_name || ''}</div>
  <div class="line"></div>
  <table><tr><td><strong>Item</strong></td><td style="text-align:center"><strong>Qty</strong></td><td style="text-align:right"><strong>Price</strong></td><td style="text-align:right"><strong>Total</strong></td></tr>
  ${itemsHtml}</table>
  <div class="line"></div>
  <table>
    <tr><td>Subtotal:</td><td style="text-align:right">£${(sale.subtotal || 0).toFixed(2)}</td></tr>
    ${sale.discount_amount ? `<tr><td>Discount:</td><td style="text-align:right">-£${sale.discount_amount.toFixed(2)}</td></tr>` : ''}
    <tr><td><strong>TOTAL:</strong></td><td style="text-align:right"><strong>£${(sale.total || 0).toFixed(2)}</strong></td></tr>
    <tr><td>Paid (${sale.payment_method || 'cash'}):</td><td style="text-align:right">£${(sale.total || 0).toFixed(2)}</td></tr>
  </table>
  <div class="line"></div>
  <div class="center">Thank you for shopping at PeacePlanet!<br>www.peaceplanet.com</div>
  <script>window.onload=function(){window.print();}</script>
</body></html>`;
  res.json({ html });
});

// Label printing
app.post('/api/print/label', authMiddleware, (req, res) => {
  const { product, label_type, store_name } = req.body;
  if (!product) return res.status(400).json({ error: 'Product data required' });

  let html;
  if (label_type === 'demo') {
    html = `<!DOCTYPE html><html><head><style>
      body { font-family: Arial; width: 60mm; margin: 0; padding: 3mm; font-size: 10px; }
      .name { font-weight: bold; font-size: 12px; }
      .price { font-size: 16px; font-weight: bold; margin-top: 2mm; }
      .demo { background: #ff0; padding: 1mm 2mm; font-weight: bold; display: inline-block; margin-top: 2mm; }
      @media print { body { margin: 0; } }
    </style></head><body>
      <div class="name">${product.name}</div>
      <div>SKU: ${product.sku || 'N/A'}</div>
      ${product.imei ? `<div>IMEI: ${product.imei}</div>` : ''}
      <div class="price">£${(product.sell_price || 0).toFixed(2)}</div>
      <div class="demo">DEMO UNIT</div>
      <div>${store_name || 'PeacePlanet'}</div>
      <script>window.onload=function(){window.print();}</script>
    </body></html>`;
  } else {
    html = `<!DOCTYPE html><html><head><style>
      body { font-family: Arial; width: 60mm; margin: 0; padding: 3mm; font-size: 10px; }
      .name { font-weight: bold; font-size: 11px; }
      .price { font-size: 14px; font-weight: bold; margin-top: 2mm; }
      @media print { body { margin: 0; } }
    </style></head><body>
      <div class="name">${product.name}</div>
      <div>SKU: ${product.sku || 'N/A'}</div>
      ${product.serial_number ? `<div>S/N: ${product.serial_number}</div>` : ''}
      <div class="price">£${(product.sell_price || 0).toFixed(2)}</div>
      <div>${store_name || 'PeacePlanet'}</div>
      <script>window.onload=function(){window.print();}</script>
    </body></html>`;
  }
  res.json({ html });
});

// ── CSV Import: Bulk import products from CellStore CSV ──
app.post('/api/import/csv-products', authMiddleware, (req, res) => {
  // Only admins can import
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { csv_text } = req.body;
  if (!csv_text) return res.status(400).json({ error: 'csv_text required' });

  try {
    // Parse CSV (handle quoted fields with commas inside)
    function parseCSVLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
          else { inQuotes = !inQuotes; }
        } else if (ch === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    }

    const lines = csv_text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });

    const header = parseCSVLine(lines[0]);
    const colIdx = {};
    header.forEach((h, i) => { colIdx[h.replace(/"/g, '').trim()] = i; });

    // Required columns check
    const needed = ['Sub-Domain', 'Id', 'Product name', 'SKU', 'Cost price', 'Selling Price', 'Current inventory', 'Category name'];
    for (const n of needed) {
      if (colIdx[n] === undefined) return res.status(400).json({ error: 'Missing column: ' + n });
    }

    // Get store mapping
    const stores = db.prepare('SELECT id, name, is_main FROM stores').all();
    const storeMap = {};
    for (const s of stores) {
      const lower = s.name.toLowerCase();
      if (s.is_main) { storeMap['store'] = s.id; storeMap['main'] = s.id; }
      if (lower.includes('omagh')) storeMap['omagh'] = s.id;
      if (lower.includes('cookstown')) storeMap['cookstown'] = s.id;
      if (lower.includes('dungannon')) storeMap['dungannon'] = s.id;
    }

    // Parse all rows and group by product Id
    const productMap = new Map(); // CellStore Id → { details, inventory: { subdomain: qty } }

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < header.length) continue;

      const subdomain = (cols[colIdx['Sub-Domain']] || '').toLowerCase();
      const csId = cols[colIdx['Id']] || '';
      const category = cols[colIdx['Category name']] || '';
      const manufacturer = cols[colIdx['Manufacturer name']] || '';
      const name = cols[colIdx['Product name']] || '';
      const color = cols[colIdx['Color Name']] || '';
      const storage = cols[colIdx['Storage']] || '';
      const sku = cols[colIdx['SKU']] || '';
      const costPrice = parseFloat(cols[colIdx['Cost price']] || '0') || 0;
      const sellPrice = parseFloat(cols[colIdx['Selling Price']] || '0') || 0;
      const qty = parseInt(cols[colIdx['Current inventory']] || '0') || 0;
      const minStock = parseInt(cols[colIdx['Minimum stock']] || '5') || 5;
      const requireRef = (cols[colIdx['Require Reference']] || '').toLowerCase() === 'yes' ? 1 : 0;

      if (!csId || !name) continue;

      if (!productMap.has(csId)) {
        // Build full product name with brand prefix from category
        // Categories like "iPhone - Screens" → prefix "iPhone", "Samsung - Screens" → "Samsung"
        // "Accessories - iPad Cases" → "iPad", "iPad - LCD" → "iPad"
        let brandPrefix = '';
        if (category) {
          const catLower = category.toLowerCase();
          // Extract brand from category (text before " - ")
          const dashIdx = category.indexOf(' - ');
          const catBrand = dashIdx > 0 ? category.substring(0, dashIdx).trim() : '';

          // Map category brands to proper display names
          const brandMap = {
            'iphone': 'iPhone', 'ipad': 'iPad', 'samsung': 'Samsung',
            'huawei': 'Huawei', 'google': 'Google', 'pixel': 'Google Pixel',
            'xiaomi': 'Xiaomi', 'oppo': 'Oppo', 'oneplus': 'OnePlus',
            'nokia': 'Nokia', 'motorola': 'Motorola', 'lg': 'LG',
            'sony': 'Sony', 'xperia': 'Sony Xperia', 'hudl': 'Hudl',
            'honor': 'Honor', 'realme': 'Realme', 'nothing': 'Nothing',
            'accessories': '', 'mobile devices': ''
          };

          // Check category brand
          if (catBrand && brandMap[catBrand.toLowerCase()] !== undefined) {
            brandPrefix = brandMap[catBrand.toLowerCase()];
          } else if (catBrand && catBrand.length > 1) {
            brandPrefix = catBrand;
          }

          // For "Accessories - iPhone Cases" etc, extract the device brand from after the dash
          if (!brandPrefix && dashIdx > 0) {
            const afterDash = category.substring(dashIdx + 3).trim().toLowerCase();
            for (const [key, val] of Object.entries(brandMap)) {
              if (afterDash.includes(key) && val) { brandPrefix = val; break; }
            }
          }
        }

        // Build name: prefix + product name + color + storage
        let fullName = name;
        // Only add brand prefix if the product name doesn't already start with it
        if (brandPrefix) {
          const nameLower = name.toLowerCase();
          const prefixLower = brandPrefix.toLowerCase();
          if (!nameLower.startsWith(prefixLower) && !nameLower.startsWith(prefixLower.split(' ').pop())) {
            fullName = brandPrefix + ' ' + name;
          }
        }
        if (color) fullName += ' ' + color;
        if (storage) fullName += ' ' + storage;

        productMap.set(csId, {
          name: fullName,
          category: category,
          manufacturer: manufacturer,
          sku: sku || ('CS-' + csId),
          costPrice: costPrice,
          sellPrice: sellPrice,
          isSerialized: requireRef,
          minStock: minStock,
          inventory: {}
        });
      }

      // Use max cost price across stores (some stores show 0)
      const prod = productMap.get(csId);
      if (costPrice > prod.costPrice) prod.costPrice = costPrice;
      if (sellPrice > prod.sellPrice) prod.sellPrice = sellPrice;

      // Store inventory
      if (storeMap[subdomain]) {
        prod.inventory[subdomain] = qty > 0 ? qty : 0;
      }
    }

    // Now do the import in a transaction
    const uuidv4 = require('uuid').v4;
    const categoryCache = {};
    let created = 0, skipped = 0, catCreated = 0;

    const importAll = db.transaction(() => {
      // Prepare statements
      const findCat = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)');
      const insertCat = db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)');
      const findProd = db.prepare('SELECT id FROM products WHERE sku = ?');
      const insertProd = db.prepare('INSERT INTO products (id, sku, name, description, category_id, cost_price, sell_price, is_serialized) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const findInv = db.prepare('SELECT id FROM inventory WHERE product_id = ? AND store_id = ?');
      const insertInv = db.prepare('INSERT INTO inventory (id, product_id, store_id, quantity, low_stock_threshold) VALUES (?, ?, ?, ?, ?)');
      const updateInv = db.prepare('UPDATE inventory SET quantity = ?, low_stock_threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND store_id = ?');

      for (const [csId, prod] of productMap) {
        // Get or create category
        let categoryId = null;
        if (prod.category) {
          if (categoryCache[prod.category.toLowerCase()]) {
            categoryId = categoryCache[prod.category.toLowerCase()];
          } else {
            const existing = findCat.get(prod.category);
            if (existing) {
              categoryId = existing.id;
            } else {
              categoryId = uuidv4();
              insertCat.run(categoryId, prod.category);
              catCreated++;
            }
            categoryCache[prod.category.toLowerCase()] = categoryId;
          }
        }

        // Check if product already exists by SKU
        const existingProd = findProd.get(prod.sku);
        if (existingProd) {
          skipped++;
          // Still update inventory for existing products
          for (const [subdomain, qty] of Object.entries(prod.inventory)) {
            const storeId = storeMap[subdomain];
            if (!storeId) continue;
            const inv = findInv.get(existingProd.id, storeId);
            if (inv) {
              updateInv.run(qty, prod.minStock, existingProd.id, storeId);
            } else {
              insertInv.run(uuidv4(), existingProd.id, storeId, qty, prod.minStock);
            }
          }
          continue;
        }

        // Create product
        const prodId = uuidv4();
        insertProd.run(prodId, prod.sku, prod.name, prod.manufacturer || '', categoryId, prod.costPrice, prod.sellPrice, prod.isSerialized);
        created++;

        // Create inventory for each store
        for (const s of stores) {
          // Find matching subdomain for this store
          let qty = 0;
          for (const [subdomain, subQty] of Object.entries(prod.inventory)) {
            if (storeMap[subdomain] === s.id) { qty = subQty; break; }
          }
          insertInv.run(uuidv4(), prodId, s.id, qty, prod.minStock);
        }
      }
    });

    importAll();

    res.json({
      success: true,
      message: `Import complete: ${created} products created, ${skipped} existing (inventory updated), ${catCreated} categories created`,
      stats: { products_created: created, products_skipped: skipped, categories_created: catCreated, total_in_csv: productMap.size }
    });
  } catch (err) {
    console.error('CSV Import error:', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ── CSV Import: Bulk import customers from CellStore CSV ──
app.post('/api/import/csv-customers', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { csv_text } = req.body;
  if (!csv_text) return res.status(400).json({ error: 'csv_text required' });

  try {
    function parseCSVLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
          else { inQuotes = !inQuotes; }
        } else if (ch === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    }

    const lines = csv_text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });

    const header = parseCSVLine(lines[0]);
    const colIdx = {};
    header.forEach((h, i) => { colIdx[h.replace(/"/g, '').trim()] = i; });

    const uuidv4 = require('uuid').v4;
    let created = 0, skipped = 0;

    const importAll = db.transaction(() => {
      const insertCust = db.prepare('INSERT INTO customers (id, first_name, last_name, email, phone, address, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (cols.length < 4) { skipped++; continue; }

        let firstName = (cols[colIdx['First Name']] || '').trim();
        let lastName = (cols[colIdx['Last Name']] || '').trim();
        const email = (cols[colIdx['Email']] || '').trim();
        const phone = (cols[colIdx['Contact No']] || '').trim();
        const company = (cols[colIdx['Company']] || '').trim();
        const addr1 = (cols[colIdx['Shipping address one']] || '').trim();
        const addr2 = (cols[colIdx['Shipping address two']] || '').trim();
        const city = (cols[colIdx['Shipping city']] || '').trim();
        const zip = (cols[colIdx['Shipping zip']] || '').trim();

        // If first name contains a space and no last name, split it
        if (firstName && !lastName && firstName.includes(' ')) {
          const parts = firstName.split(/\s+/);
          firstName = parts[0];
          lastName = parts.slice(1).join(' ');
        }

        // Filter junk: must have at least 2 alpha chars in first name
        const alphaCount = (firstName.match(/[a-zA-Z]/g) || []).length;
        if (alphaCount < 2) { skipped++; continue; }

        // Build address string
        const addrParts = [addr1, addr2, city, zip].filter(Boolean);
        const address = addrParts.join(', ') || null;

        // Notes: include company if present
        const notes = company ? 'Company: ' + company : null;

        insertCust.run(uuidv4(), firstName, lastName || null, email || null, phone || null, address, notes);
        created++;
      }
    });

    importAll();

    res.json({
      success: true,
      message: 'Import complete: ' + created + ' customers created, ' + skipped + ' junk entries skipped',
      stats: { customers_created: created, skipped: skipped }
    });
  } catch (err) {
    console.error('Customer CSV Import error:', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// Monitor mode page (standalone HTML)
app.get('/monitor/:storeId', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PeacePlanet - Repair Status</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif; background: #000; color: #fff; min-height: 100vh; }
  .header { text-align: center; padding: 40px 20px 20px; }
  .header h1 { font-size: 42px; font-weight: 700; letter-spacing: -0.03em; }
  .header p { color: #8e8e93; font-size: 18px; margin-top: 8px; }
  .status-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; padding: 20px 40px; }
  .repair-card { background: #1c1c1e; border-radius: 16px; padding: 24px; border: 1px solid #2c2c2e; }
  .repair-card .ticket { font-size: 13px; color: #8e8e93; font-weight: 600; letter-spacing: 0.03em; }
  .repair-card .device { font-size: 20px; font-weight: 700; margin: 8px 0 4px; }
  .repair-card .customer { font-size: 14px; color: #aeaeb2; }
  .repair-card .status { display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-top: 12px; }
  .status-checked_in { background: rgba(0,122,255,0.2); color: #5ac8fa; }
  .status-diagnosing { background: rgba(255,159,10,0.2); color: #ff9f0a; }
  .status-awaiting_parts { background: rgba(255,59,48,0.15); color: #ff453a; }
  .status-in_repair { background: rgba(255,159,10,0.2); color: #ff9f0a; }
  .status-ready { background: rgba(48,209,88,0.2); color: #30d158; }
  .status-completed { background: rgba(48,209,88,0.2); color: #30d158; }
  .priority-urgent { border-left: 4px solid #ff453a; }
  .priority-high { border-left: 4px solid #ff9f0a; }
  .empty { text-align: center; padding: 80px; color: #636366; font-size: 20px; }
  .updated { text-align: center; padding: 20px; color: #48484a; font-size: 13px; }
</style></head><body>
<div class="header">
  <h1>PeacePlanet</h1>
  <p id="storeName">Repair Status Board</p>
</div>
<div class="status-grid" id="repairGrid"></div>
<div class="updated" id="lastUpdated"></div>
<script>
  const storeId = '${req.params.storeId}';
  const labels = { checked_in:'Checked In', diagnosing:'Diagnosing', awaiting_parts:'Awaiting Parts', in_repair:'In Repair', ready:'Ready for Collection', completed:'Completed' };

  async function refresh() {
    try {
      const res = await fetch('/api/monitor/repairs/' + storeId);
      const data = await res.json();
      document.getElementById('storeName').textContent = data.store.name + ' — Repair Status';
      const grid = document.getElementById('repairGrid');
      if (data.repairs.length === 0) {
        grid.innerHTML = '<div class="empty"><i class="fas fa-check-circle" style="font-size:48px;margin-bottom:16px;display:block"></i>No active repairs</div>';
      } else {
        grid.innerHTML = data.repairs.map(r => '<div class="repair-card priority-' + r.priority + '">' +
          '<div class="ticket">' + r.ticket_number + '</div>' +
          '<div class="device">' + (r.device_brand||'') + ' ' + (r.device_model||'') + '</div>' +
          '<div class="customer">' + (r.customer_initial||'') + '</div>' +
          '<div class="status status-' + r.status + '">' + (labels[r.status]||r.status) + '</div>' +
        '</div>').join('');
      }
      document.getElementById('lastUpdated').textContent = 'Last updated: ' + new Date().toLocaleTimeString('en-GB');
    } catch(e) { console.error(e); }
  }
  refresh();
  setInterval(refresh, 30000); // Auto-refresh every 30 seconds
</script></body></html>`);
});

// POS monitor mode (locked down, no back office)
app.get('/pos-monitor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🟢 PeacePlanet POS running at http://localhost:${PORT}`);
  console.log(`   Login: admin@peaceplanet.com / admin123`);
  console.log(`   Monitor mode: http://localhost:${PORT}/monitor/{store-id}\n`);
});
