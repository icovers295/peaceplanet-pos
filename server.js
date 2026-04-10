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

// API Routes — stripSensitiveData removes cost prices for non-admins
app.use('/api/auth', require('./routes/auth'));
app.use('/api/stores', require('./routes/stores'));
app.use('/api/products', stripSensitiveData, require('./routes/products'));
app.use('/api/sales', stripSensitiveData, require('./routes/sales'));
app.use('/api/repairs', stripSensitiveData, require('./routes/repairs'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/purchase-orders', stripSensitiveData, require('./routes/purchase-orders'));

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
