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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database
initialize();

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/stores', require('./routes/stores'));
app.use('/api/products', stripSensitiveData, require('./routes/products'));
app.use('/api/sales', stripSensitiveData, require('./routes/sales'));
app.use('/api/repairs', stripSensitiveData, require('./routes/repairs'));
app.use('/api/customers', require('./routes/customers'));

// User permissions endpoint
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

// Monitor Mode: Public repair status board (no auth needed)
app.get('/api/monitor/repairs/:storeId', (req, res) => {
  const store = db.prepare('SELECT id, name FROM stores WHERE id = ? AND is_main = 0').get(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });
  const repairs = db.prepare(`SELECT r.ticket_number, r.device_brand, r.device_model, r.status, r.priority, SUBSTR(c.first_name, 1, 1) || '. ' || COALESCE(c.last_name, '') as customer_initial FROM repairs r LEFT JOIN customers c ON r.customer_id = c.id WHERE r.store_id = ? AND r.status NOT IN ('collected') ORDER BY CASE r.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, r.created_at DESC LIMIT 20`).all(req.params.storeId);
  res.json({ store, repairs });
});

// Stock Transfer endpoint
app.get('/api/transfers', authMiddleware, (req, res) => {
  const { store_id, status } = req.query;
  let where = [];
  let params = [];
  if (store_id) { where.push('(st.from_store_id = ? OR st.to_store_id = ?)'); params.push(store_id, store_id); }
  if (status) { where.push('st.status = ?'); params.push(status); }
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const transfers = db.prepare(`SELECT st.*, p.name as product_name, p.sku, fs.name as from_store_name, ts.name as to_store_name, u.first_name || ' ' || u.last_name as created_by_name FROM stock_transfers st JOIN products p ON st.product_id = p.id JOIN stores fs ON st.from_store_id = fs.id JOIN stores ts ON st.to_store_id = ts.id LEFT JOIN users u ON st.created_by = u.id ${whereClause} ORDER BY st.created_at DESC LIMIT 100`).all(...params);
  res.json(transfers);
});const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`PeacePlanet POS server running on port ${PORT}`);
});

// Receipt printing
app.post('/api/print/receipt', authMiddleware, (req, res) => {
  const { sale } = req.body;
  if (!sale) return res.status(400).json({ error: 'Sale data required' });
  const itemsHtml = (sale.items || []).map(item => `<tr><td>${item.product_name || item.name}</td><td style="text-align:center">${item.quantity}</td><td style="text-align:right">\u00A3${(item.unit_price || 0).toFixed(2)}</td><td style="text-align:right">\u00A3${(item.total || 0).toFixed(2)}</td></tr>`).join('');
  const html = `<!DOCTYPE html><html><head><style>body{font-family:'Courier New',monospace;width:280px;margin:0 auto;font-size:12px;}.center{text-align:center;}table{width:100%;border-collapse:collapse;}td{padding:2px 0;}.line{border-top:1px dashed #000;margin:5px 0;}@media print{body{margin:0;}}</style></head><body><div class="center"><strong>PEACEPLANET</strong><br>${sale.store_name||''}<br><br></div><div>Receipt: ${sale.receipt_number}<br>Date: ${new Date(sale.created_at||Date.now()).toLocaleString('en-GB')}<br>Cashier: ${sale.cashier_name||''}</div><div class="line"></div><table><tr><td><strong>Item</strong></td><td style="text-align:center"><strong>Qty</strong></td><td style="text-align:right"><strong>Price</strong></td><td style="text-align:right"><strong>Total</strong></td></tr>${itemsHtml}</table><div class="line"></div><table><tr><td>Subtotal:</td><td style="text-align:right">\u00A3${(sale.subtotal||0).toFixed(2)}</td></tr>${sale.discount_amount?`<tr><td>Discount:</td><td style="text-align:right">-\u00A3${sale.discount_amount.toFixed(2)}</td></tr>`:''}<tr><td><strong>TOTAL:</strong></td><td style="text-align:right"><strong>\u00A3${(sale.total||0).toFixed(2)}</strong></td></tr><tr><td>Paid (${sale.payment_method||'cash'}):</td><td style="text-align:right">\u00A3${(sale.total||0).toFixed(2)}</td></tr></table><div class="line"></div><div class="center">Thank you for shopping at PeacePlanet!<br>www.peaceplanet.com</div><script>window.onload=function(){window.print();}<\/script></body></html>`;
  res.json({ html });
});

// Label printing
app.post('/api/print/label', authMiddleware, (req, res) => {
  const { product, label_type, store_name } = req.body;
  if (!product) return res.status(400).json({ error: 'Product data required' });
  let html;
  if (label_type === 'demo') {
    html = `<!DOCTYPE html><html><head><style>body{font-family:Arial;width:60mm;margin:0;padding:3mm;font-size:10px;}.name{font-weight:bold;font-size:12px;}.price{font-size:16px;font-weight:bold;margin-top:2mm;}.demo{background:#ff0;padding:1mm 2mm;font-weight:bold;display:inline-block;margin-top:2mm;}@media print{body{margin:0;}}</style></head><body><div class="name">${product.name}</div><div>SKU: ${product.sku||'N/A'}</div>${product.imei?`<div>IMEI: ${product.imei}</div>`:''}<div class="price">\u00A3${(product.sell_price||0).toFixed(2)}</div><div class="demo">DEMO UNIT</div><div>${store_name||'PeacePlanet'}</div><script>window.onload=function(){window.print();}<\/script></body></html>`;
  } else {
    html = `<!DOCTYPE html><html><head><style>body{font-family:Arial;width:60mm;margin:0;padding:3mm;font-size:10px;}.name{font-weight:bold;font-size:11px;}.price{font-size:14px;font-weight:bold;margin-top:2mm;}@media print{body{margin:0;}}</style></head><body><div class="name">${product.name}</div><div>SKU: ${product.sku||'N/A'}</div>${product.serial_number?`<div>S/N: ${product.serial_number}</div>`:''}<div class="price">\u00A3${(product.sell_price||0).toFixed(2)}</div><div>${store_name||'PeacePlanet'}</div><script>window.onload=function(){window.print();}<\/script></body></html>`;
  }
  res.json({ html });
});

// POS monitor mode
app.get('/pos-monitor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('PeacePlanet POS running at http://localhost:' + PORT);
  console.log('Login: admin@peaceplanet.com / admin123');
});
