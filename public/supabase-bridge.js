/*
 * PeacePlanet POS — Supabase Bridge
 *
 * Replaces PREVIEW.html's in-browser localStorage with a live Supabase backend
 * so every till in every shop reads/writes the same data in real time.
 *
 * How it plugs in:
 *   1. Load @supabase/supabase-js v2 from CDN.
 *   2. Include this file BEFORE the PREVIEW.html main <script>.
 *   3. At the top of the main script, call `await SBridge.init(...)` and wait.
 *   4. PREVIEW's existing load()/save() functions are monkey-patched to hit
 *      Supabase under the hood. Zero changes needed to the UI code.
 *
 * Cache model:
 *   - On init we hydrate every "bucket" (products, customers, sales, repairs,
 *     transfers, purchaseOrders) into SBridge._cache, shaped exactly like the
 *     arrays PREVIEW used to store in localStorage.
 *   - load(key)  → returns SBridge._cache[key]  (synchronous, like before)
 *   - save(key, v) → does a smart diff vs previous snapshot and writes only
 *     the changes to Supabase (async, fire-and-forget, with an error log).
 *   - Realtime subscriptions on products, stock_levels, sales, repairs update
 *     the cache when another till writes, so screens reflect changes instantly.
 */
(function (global) {
  'use strict';

  const STORE_NAMES = ['Main', 'Dungannon', 'Cookstown', 'Omagh'];

  const SBridge = {
    client: null,
    // Mapping: business-friendly names ↔ Supabase UUIDs
    storeIdByName:   {},      // 'Main' → uuid
    storeNameById:   {},      // uuid → 'Main'
    categoryIdByName: {},     // 'Accessories' → uuid
    categoryNameById: {},     // uuid → 'Accessories'
    // In-memory cache (the "source of truth" the UI sees via load())
    _cache: {
      products:       [],
      customers:      [],
      sales:          [],
      repairs:        [],
      transfers:      [],
      purchaseOrders: [],
      users:          [],
    },
    // Previous snapshot per bucket — used to diff on save()
    _prev: {},
    // Logged-in user
    currentUser: null,

    async init({ url, anonKey }) {
      if (!global.supabase || !global.supabase.createClient) {
        throw new Error('Supabase JS v2 not loaded. Add the CDN <script> first.');
      }
      this.client = global.supabase.createClient(url, anonKey, {
        realtime: { params: { eventsPerSecond: 10 } },
      });
      await this._loadStores();
      await this._loadCategories();
      await this._hydrateAll();
      this._installLoadSave();
      this._subscribeRealtime();
      console.log('[SBridge] ready —',
        this._cache.products.length, 'products,',
        this._cache.sales.length, 'sales,',
        this._cache.repairs.length, 'repairs');
    },

    // ── Authentication: PREVIEW's login screen hits staff table directly ──
    async login(email, password) {
      const { data, error } = await this.client
        .from('staff')
        .select('id, name, email, password, role, active')
        .eq('email', email)
        .eq('active', true)
        .maybeSingle();
      if (error) throw error;
      if (!data || data.password !== password) return null;
      // Load this user's store access
      const { data: access } = await this.client
        .from('staff_stores')
        .select('store_id')
        .eq('staff_id', data.id);
      const stores = (access || [])
        .map(r => this.storeNameById[r.store_id])
        .filter(Boolean);
      // If admin, give access to all
      const storesForUser = data.role === 'admin' ? STORE_NAMES : stores;
      this.currentUser = {
        id: data.id, name: data.name, email: data.email,
        role: data.role, stores: storesForUser, active: data.active,
      };
      return this.currentUser;
    },

    // ────────────────────────────── HYDRATE ──────────────────────────────
    async _loadStores() {
      const { data } = await this.client.from('stores').select('id,name');
      for (const s of data || []) {
        this.storeIdByName[s.name] = s.id;
        this.storeNameById[s.id]   = s.name;
      }
    },

    async _loadCategories() {
      const { data } = await this.client.from('categories').select('id,name');
      for (const c of data || []) {
        this.categoryIdByName[c.name] = c.id;
        this.categoryNameById[c.id]   = c.name;
      }
    },

    async _hydrateAll() {
      await Promise.all([
        this._hydrateProducts(),
        this._hydrateCustomers(),
        this._hydrateSales(),
        this._hydrateRepairs(),
        this._hydrateTransfers(),
        this._hydratePurchaseOrders(),
        this._hydrateUsers(),
      ]);
      // Take initial snapshots for diff-on-save
      for (const k of Object.keys(this._cache)) {
        this._prev[k] = JSON.stringify(this._cache[k]);
      }
    },

    async _hydrateProducts() {
      // Page through products (Supabase caps at 1000 per request)
      const all = [];
      let from = 0, size = 1000;
      while (true) {
        const { data, error } = await this.client
          .from('products')
          .select('id,sku,name,manufacturer,category_id,cost_price,sell_price,active')
          .range(from, from + size - 1);
        if (error) throw error;
        all.push(...data);
        if (data.length < size) break;
        from += size;
      }
      // Build initial product list with zeroed stock
      const byId = new Map();
      for (const p of all) {
        byId.set(p.id, {
          id: p.id,
          sku: p.sku || '',
          name: p.name || '',
          manufacturer: p.manufacturer || '',
          cat: this.categoryNameById[p.category_id] || '',
          cost: Number(p.cost_price) || 0,
          sell: Number(p.sell_price) || 0,
          stock: { Main: 0, Dungannon: 0, Cookstown: 0, Omagh: 0 },
          _active: p.active !== false,
        });
      }
      // Pull stock levels and fold into products
      from = 0;
      while (true) {
        const { data, error } = await this.client
          .from('stock_levels')
          .select('product_id,store_id,quantity')
          .range(from, from + size - 1);
        if (error) throw error;
        for (const sl of data) {
          const p = byId.get(sl.product_id);
          const storeName = this.storeNameById[sl.store_id];
          if (p && storeName) p.stock[storeName] = Number(sl.quantity) || 0;
        }
        if (data.length < size) break;
        from += size;
      }
      this._cache.products = Array.from(byId.values()).filter(p => p._active);
    },

    async _hydrateCustomers() {
      const { data } = await this.client
        .from('customers')
        .select('id,name,phone,email,created_at');
      this._cache.customers = (data || []).map(c => ({
        id: c.id, name: c.name || '', phone: c.phone || '',
        email: c.email || '', notes: '', created: c.created_at,
      }));
    },

    async _hydrateSales() {
      const { data: sales } = await this.client
        .from('sales')
        .select('id,receipt_number,store_id,staff_id,cashier_name,payment_method,subtotal,discount,total,customer_id,status,sale_date')
        .order('sale_date', { ascending: false })
        .limit(500);
      const saleIds = (sales || []).map(s => s.id);
      const itemsBySale = {};
      if (saleIds.length) {
        const { data: items } = await this.client
          .from('sale_items')
          .select('sale_id,product_id,product_name,quantity,unit_price,line_total')
          .in('sale_id', saleIds);
        for (const it of items || []) {
          (itemsBySale[it.sale_id] ||= []).push({
            product_id: it.product_id, name: it.product_name,
            qty: it.quantity, price: Number(it.unit_price),
          });
        }
      }
      this._cache.sales = (sales || []).map(s => ({
        id: s.id,
        receipt: s.receipt_number,
        store: this.storeNameById[s.store_id] || '',
        cashier: s.cashier_name || '',
        items: itemsBySale[s.id] || [],
        subtotal: Number(s.subtotal), discount: Number(s.discount),
        total: Number(s.total), method: s.payment_method,
        customer_id: s.customer_id, status: s.status,
        date: s.sale_date,
      }));
    },

    async _hydrateRepairs() {
      const { data: repairs } = await this.client
        .from('repairs')
        .select('id,ticket_number,store_id,staff_id,customer_id,device_type,device_model,issue_description,status,priority,estimated_cost,total_paid,notes,created_at,updated_at')
        .order('created_at', { ascending: false })
        .limit(500);
      const ids = (repairs || []).map(r => r.id);
      const partsById = {};
      if (ids.length) {
        const { data: parts } = await this.client
          .from('repair_parts')
          .select('repair_id,product_id,product_name,quantity,unit_price,stock_deducted')
          .in('repair_id', ids);
        for (const p of parts || []) {
          (partsById[p.repair_id] ||= []).push({
            product_id: p.product_id, name: p.product_name,
            qty: p.quantity, price: Number(p.unit_price),
            stock_deducted: p.stock_deducted,
          });
        }
      }
      this._cache.repairs = (repairs || []).map(r => ({
        id: r.id, ticket: r.ticket_number,
        store: this.storeNameById[r.store_id] || '',
        customer_id: r.customer_id,
        device_type: r.device_type, device_model: r.device_model,
        issue: r.issue_description, status: r.status, priority: r.priority,
        total: Number(r.estimated_cost), paid: Number(r.total_paid),
        parts: partsById[r.id] || [], notes: r.notes || '',
        created: r.created_at, updated: r.updated_at,
      }));
    },

    async _hydrateTransfers() {
      const { data } = await this.client
        .from('stock_transfers')
        .select('id,from_store_id,to_store_id,product_id,product_name,quantity,staff_id,transferred_at')
        .order('transferred_at', { ascending: false })
        .limit(500);
      this._cache.transfers = (data || []).map(t => ({
        id: t.id,
        from: this.storeNameById[t.from_store_id] || '',
        to:   this.storeNameById[t.to_store_id] || '',
        product_id: t.product_id, product_name: t.product_name,
        qty: t.quantity, date: t.transferred_at,
      }));
    },

    async _hydratePurchaseOrders() {
      const { data: pos } = await this.client
        .from('purchase_orders')
        .select('id,supplier_name,invoice_ref,receiving_store_id,staff_id,status,total_cost,created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      const ids = (pos || []).map(p => p.id);
      const itemsById = {};
      if (ids.length) {
        const { data: items } = await this.client
          .from('po_items')
          .select('po_id,product_id,product_name,quantity,cost_per_item')
          .in('po_id', ids);
        for (const it of items || []) {
          (itemsById[it.po_id] ||= []).push({
            product_id: it.product_id, name: it.product_name,
            qty: it.quantity, cost: Number(it.cost_per_item),
          });
        }
      }
      this._cache.purchaseOrders = (pos || []).map(p => ({
        id: p.id, supplier: p.supplier_name, invoice: p.invoice_ref,
        store: this.storeNameById[p.receiving_store_id] || '',
        status: p.status, total: Number(p.total_cost),
        items: itemsById[p.id] || [], date: p.created_at,
      }));
    },

    async _hydrateUsers() {
      const { data: staff } = await this.client
        .from('staff')
        .select('id,name,email,password,role,active');
      const { data: access } = await this.client
        .from('staff_stores')
        .select('staff_id,store_id');
      const storesByStaff = {};
      for (const a of access || []) {
        (storesByStaff[a.staff_id] ||= []).push(
          this.storeNameById[a.store_id]
        );
      }
      this._cache.users = (staff || []).map(u => ({
        id: u.id, name: u.name, email: u.email, password: u.password,
        role: u.role, active: u.active,
        stores: u.role === 'admin' ? STORE_NAMES
                                   : (storesByStaff[u.id] || []).filter(Boolean),
      }));
    },

    // ────────────────────── LOAD / SAVE OVERRIDES ──────────────────────
    _installLoadSave() {
      const bridge = this;
      // Expose as globals so PREVIEW's inlined load()/save() pick these up.
      global.load = function (key, def) {
        if (key === 'data_version') {
          // Keep localStorage version marker to bypass PREVIEW's seed() reset
          return localStorage.getItem('pp_data_version') || '';
        }
        return bridge._cache[key] !== undefined ? bridge._cache[key] : def;
      };
      global.save = function (key, val) {
        if (key === 'data_version') {
          localStorage.setItem('pp_data_version', val);
          return;
        }
        bridge._cache[key] = val;
        // Fire-and-forget diff write — errors surface in console, never block UI
        bridge._syncBucket(key).catch(e => {
          console.error(`[SBridge] sync failed for ${key}:`, e);
        });
      };
    },

    // ───────────────────────── DIFF-BASED SYNC ─────────────────────────
    async _syncBucket(key) {
      const next = this._cache[key];
      const prev = this._prev[key] ? JSON.parse(this._prev[key]) : [];
      this._prev[key] = JSON.stringify(next);
      switch (key) {
        case 'sales':          return this._syncSales(prev, next);
        case 'repairs':        return this._syncRepairs(prev, next);
        case 'customers':      return this._syncCustomers(prev, next);
        case 'transfers':      return this._syncTransfers(prev, next);
        case 'purchaseOrders': return this._syncPOs(prev, next);
        case 'products':       return this._syncProducts(prev, next);
        case 'users':          return; // staff managed directly in Supabase for now
      }
    },

    // Find items in `next` that aren't in `prev` (by id)
    _added(prev, next) {
      const prevIds = new Set(prev.map(x => x.id));
      return next.filter(x => !prevIds.has(x.id));
    },

    async _syncSales(prev, next) {
      for (const s of this._added(prev, next)) {
        const { data: row, error } = await this.client.from('sales').insert({
          receipt_number: s.receipt,
          store_id: this.storeIdByName[s.store],
          staff_id: this.currentUser?.id,
          cashier_name: s.cashier || this.currentUser?.name,
          payment_method: s.method,
          subtotal: s.subtotal, discount: s.discount || 0, total: s.total,
          customer_id: s.customer_id || null,
          status: 'completed',
          sale_date: s.date || new Date().toISOString(),
        }).select().single();
        if (error) throw error;
        if (s.items?.length) {
          await this.client.from('sale_items').insert(s.items.map(it => ({
            sale_id: row.id,
            product_id: it.product_id,
            product_name: it.name,
            quantity: it.qty,
            unit_price: it.price,
            line_total: it.price * it.qty,
          })));
        }
      }
    },

    async _syncCustomers(prev, next) {
      for (const c of this._added(prev, next)) {
        await this.client.from('customers').insert({
          id: c.id, name: c.name || '', phone: c.phone || null, email: c.email || null,
        });
      }
    },

    async _syncRepairs(prev, next) {
      for (const r of this._added(prev, next)) {
        const { error } = await this.client.from('repairs').insert({
          id: r.id, ticket_number: r.ticket,
          store_id: this.storeIdByName[r.store],
          staff_id: this.currentUser?.id, customer_id: r.customer_id,
          device_type: r.device_type, device_model: r.device_model,
          issue_description: r.issue, status: r.status || 'Checked In',
          priority: r.priority || 'normal',
          estimated_cost: r.total || 0, total_paid: r.paid || 0,
          notes: r.notes || null,
        });
        if (error) throw error;
      }
      // Updates (status/paid changes)
      for (const r of next) {
        const p = prev.find(x => x.id === r.id);
        if (p && (p.status !== r.status || p.paid !== r.paid || p.total !== r.total)) {
          await this.client.from('repairs').update({
            status: r.status, total_paid: r.paid, estimated_cost: r.total,
          }).eq('id', r.id);
        }
      }
    },

    async _syncTransfers(prev, next) {
      for (const t of this._added(prev, next)) {
        await this.client.from('stock_transfers').insert({
          id: t.id,
          from_store_id: this.storeIdByName[t.from],
          to_store_id:   this.storeIdByName[t.to],
          product_id: t.product_id, product_name: t.product_name,
          quantity: t.qty, staff_id: this.currentUser?.id,
        });
      }
    },

    async _syncPOs(prev, next) {
      for (const po of this._added(prev, next)) {
        const { data: row, error } = await this.client.from('purchase_orders').insert({
          supplier_name: po.supplier, invoice_ref: po.invoice,
          receiving_store_id: this.storeIdByName[po.store],
          staff_id: this.currentUser?.id, status: po.status || 'pending',
          total_cost: po.total || 0,
        }).select().single();
        if (error) throw error;
        if (po.items?.length) {
          await this.client.from('po_items').insert(po.items.map(it => ({
            po_id: row.id, product_id: it.product_id, product_name: it.name,
            quantity: it.qty, cost_per_item: it.cost,
          })));
        }
      }
    },

    async _syncProducts(prev, next) {
      const prevById = new Map(prev.map(p => [p.id, p]));
      for (const p of next) {
        const old = prevById.get(p.id);
        // NEW PRODUCT
        if (!old) {
          await this.client.from('products').insert({
            id: p.id, sku: p.sku, name: p.name, manufacturer: p.manufacturer,
            category_id: this.categoryIdByName[p.cat] || null,
            cost_price: p.cost, sell_price: p.sell, active: true,
          });
          for (const sid of STORE_NAMES) {
            await this.client.from('stock_levels').insert({
              product_id: p.id, store_id: this.storeIdByName[sid],
              quantity: Number(p.stock?.[sid]) || 0,
            });
          }
          continue;
        }
        // FIELD CHANGES
        if (old.name !== p.name || old.sku !== p.sku || old.sell !== p.sell
            || old.cost !== p.cost || old.manufacturer !== p.manufacturer
            || old.cat !== p.cat) {
          await this.client.from('products').update({
            sku: p.sku, name: p.name, manufacturer: p.manufacturer,
            category_id: this.categoryIdByName[p.cat] || null,
            cost_price: p.cost, sell_price: p.sell,
          }).eq('id', p.id);
        }
        // STOCK CHANGES (per store)
        for (const sid of STORE_NAMES) {
          const oldQty = Number(old.stock?.[sid]) || 0;
          const newQty = Number(p.stock?.[sid]) || 0;
          if (oldQty !== newQty) {
            // Upsert: update if exists, insert otherwise
            const { error: updErr, count } = await this.client
              .from('stock_levels')
              .update({ quantity: newQty }, { count: 'exact' })
              .eq('product_id', p.id)
              .eq('store_id', this.storeIdByName[sid]);
            if (!count) {
              await this.client.from('stock_levels').insert({
                product_id: p.id, store_id: this.storeIdByName[sid],
                quantity: newQty,
              });
            }
          }
        }
      }
    },

    // ─────────────────────────── REALTIME ───────────────────────────
    _subscribeRealtime() {
      const bridge = this;
      // When someone else inserts a sale, pull fresh sales list in background.
      this.client.channel('pp-sales')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sales' },
          async () => { await bridge._hydrateSales(); bridge._prev.sales = JSON.stringify(bridge._cache.sales); bridge._emit('sales'); })
        .subscribe();
      this.client.channel('pp-stock')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_levels' },
          async (payload) => { await bridge._applyStockChange(payload); bridge._emit('products'); })
        .subscribe();
      this.client.channel('pp-repairs')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'repairs' },
          async () => { await bridge._hydrateRepairs(); bridge._prev.repairs = JSON.stringify(bridge._cache.repairs); bridge._emit('repairs'); })
        .subscribe();
    },

    async _applyStockChange(payload) {
      const row = payload.new || payload.old;
      if (!row) return;
      const storeName = this.storeNameById[row.store_id];
      const product = this._cache.products.find(p => p.id === row.product_id);
      if (product && storeName) {
        product.stock[storeName] = Number(payload.new?.quantity) || 0;
        this._prev.products = JSON.stringify(this._cache.products);
      }
    },

    _listeners: {},
    on(key, fn) { (this._listeners[key] ||= []).push(fn); },
    _emit(key) { (this._listeners[key] || []).forEach(fn => { try { fn(); } catch {} }); },
  };

  global.SBridge = SBridge;
})(typeof window !== 'undefined' ? window : globalThis);
