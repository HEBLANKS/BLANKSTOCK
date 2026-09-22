const path = require('path');
const fs = require('fs');
if (fs.existsSync(path.join(__dirname, '..', '.env'))) process.loadEnvFile(path.join(__dirname, '..', '.env'));

const crypto = require('crypto');
const express = require('express');
const { db, getSetting, setSetting } = require('./db');
const stock = require('./stock');
const shopify = require('./shopify');
const { invoiceHtml, invoiceCsv, invoiceData } = require('./invoice');

const app = express();
app.set('trust proxy', 1);

// ---------- Shopify webhooks (need the raw body for signature check) ----------
app.post('/webhooks', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const shop = req.get('X-Shopify-Shop-Domain');
  if (!shopify.verifyWebhook(req.body, req.get('X-Shopify-Hmac-Sha256'), shop)) return res.status(401).send('bad hmac');
  try {
    const r = await shopify.handleWebhook({ topic: req.get('X-Shopify-Topic'), shop, webhookId: req.get('X-Shopify-Webhook-Id') || req.get('X-Shopify-Event-Id'), body: JSON.parse(req.body.toString('utf8')) });
    res.send(r);
  } catch (e) { console.error('webhook', e); res.status(500).send('error'); }
});

app.use(express.json({ limit: '2mb' }));

// ---------- Login (one shared password for the team) ----------
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(p => p[0]));
function authed(req) {
  const v = cookie(req).bs; if (!v) return false;
  const [exp, sig] = v.split('.');
  return sig === sign(exp) && Number(exp) > Date.now();
}
app.post('/api/login', (req, res) => {
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!pw || String(req.body.password || '') !== pw) return res.status(401).json({ error: 'Wrong password' });
  const exp = String(Date.now() + 30 * 864e5);
  res.setHeader('Set-Cookie', `bs=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'bs=; Path=/; Max-Age=0'); res.json({ ok: true }); });
const guard = (req, res, next) => authed(req) ? next() : res.status(401).json({ error: 'Not logged in' });
app.use('/api', guard);
app.use('/invoices', guard);

const wrap = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { console.error(e); res.status(400).json({ error: e.message }); } };
const int = v => Number.parseInt(v, 10);

// ---------- Shopify install / OAuth (public: the brand owner clicks this) ----------
app.get('/shopify/install', (req, res) => {
  const shop = shopify.normShop(req.query.shop);
  const known = shop && db.prepare('SELECT * FROM stores WHERE shop=?').get(shop);
  if (!known) return res.status(400).send('This store has not been added in BlankStock yet. Add it under Clients & stores first.');
  try { res.redirect(shopify.installUrl(shop)); } catch (e) { res.status(400).send(e.message); }
});
app.get('/shopify/callback', async (req, res) => {
  try {
    const store = await shopify.handleCallback(req.query);
    try { await shopify.registerWebhooks(store); } catch (e) { db.prepare('UPDATE stores SET status_note=? WHERE id=?').run('Webhooks: ' + e.message, store.id); }
    shopify.syncStore(db.prepare('SELECT * FROM stores WHERE id=?').get(store.id), { sinceDays: 14 }).catch(e => console.error('initial sync', e.message));
    res.send(`<p style="font:16px system-ui;margin:40px">✅ ${store.shop} is connected to BlankStock. You can close this tab.</p>`);
  } catch (e) { res.status(400).send(`<p style="font:16px system-ui;margin:40px">Couldn't connect: ${String(e.message).replace(/</g, '&lt;')}</p>`); }
});

// ---------- Dashboard ----------
app.get('/api/summary', wrap(() => {
  const clients = db.prepare('SELECT id,name FROM clients ORDER BY name').all().map(c => {
    const rows = stock.stockFor(c.id);
    const o = db.prepare(`SELECT
        COUNT(DISTINCT CASE WHEN o.status='new' THEN o.id END) open_orders,
        COUNT(DISTINCT CASE WHEN o.status='new' AND (ol.short_qty>0 OR ol.processed=0) THEN o.id END) blocked_orders,
        COALESCE(SUM(CASE WHEN o.status='new' AND ol.processed=0 THEN 1 END),0) unmapped_lines
      FROM orders o JOIN stores s ON s.id=o.store_id LEFT JOIN order_lines ol ON ol.order_id=o.id
      WHERE s.client_id=? AND o.cancelled=0`).get(c.id);
    return { ...c, ...o,
      short_units: rows.reduce((s, r) => s + Math.max(0, -r.on_hand), 0),
      low_skus: rows.filter(r => r.status === 'low').length,
      short_skus: rows.filter(r => r.status === 'short').length,
      on_hand: rows.reduce((s, r) => s + Math.max(0, r.on_hand), 0),
      stock_value: rows.reduce((s, r) => s + Math.max(0, r.on_hand) * r.unit_cost, 0),
      to_invoice: rows.reduce((s, r) => s + r.suggest, 0) };
  });
  const stores = db.prepare('SELECT s.id,s.shop,s.status,s.status_note,s.last_synced_at,c.name client FROM stores s JOIN clients c ON c.id=s.client_id').all();
  return { clients, stores };
}));

// ---------- Settings ----------
const SETTING_KEYS = ['biz_name', 'biz_address', 'biz_email', 'vat_number', 'vat_rate', 'bank_details', 'payment_terms', 'invoice_prefix', 'next_invoice'];
app.get('/api/settings', wrap(() => ({
  ...Object.fromEntries(SETTING_KEYS.map(k => [k, getSetting(k)])),
  _app_url: process.env.APP_URL || '', _api_version: shopify.API_VERSION, _has_default_app: !!(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET)
})));
app.put('/api/settings', wrap(req => { for (const k of SETTING_KEYS) if (k in req.body) setSetting(k, req.body[k]); return { ok: true }; }));

// ---------- Clients ----------
app.get('/api/clients', wrap(() => db.prepare('SELECT * FROM clients ORDER BY name').all()));
app.post('/api/clients', wrap(req => {
  const { name, email, markup_pct = 0, handling_fee = 0, notes } = req.body;
  if (!name) throw new Error('Name required');
  return { id: db.prepare('INSERT INTO clients(name,email,markup_pct,handling_fee,notes) VALUES(?,?,?,?,?)').run(name, email, +markup_pct || 0, +handling_fee || 0, notes).lastInsertRowid };
}));
app.put('/api/clients/:id', wrap(req => {
  const c = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id); if (!c) throw new Error('Not found');
  const n = { ...c, ...req.body };
  db.prepare('UPDATE clients SET name=?,email=?,markup_pct=?,handling_fee=?,notes=? WHERE id=?').run(n.name, n.email, +n.markup_pct || 0, +n.handling_fee || 0, n.notes, c.id);
  return { ok: true };
}));
app.delete('/api/clients/:id', wrap(req => { db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id); return { ok: true }; }));

// ---------- Stores ----------
app.get('/api/stores', wrap(() => db.prepare(`SELECT s.id,s.client_id,s.shop,s.auth_mode,s.status,s.status_note,s.webhooks_registered,s.last_synced_at,c.name client,
  (s.access_token IS NOT NULL) has_token FROM stores s JOIN clients c ON c.id=s.client_id ORDER BY c.name`).all()
  .map(s => ({ ...s, install_link: `${process.env.APP_URL || ''}/shopify/install?shop=${s.shop}` }))));

app.post('/api/stores', wrap(async req => {
  const shop = shopify.normShop(req.body.shop);
  if (!shop) throw new Error('Enter the store as brand-name.myshopify.com');
  const mode = ['oauth', 'client_credentials', 'token'].includes(req.body.auth_mode) ? req.body.auth_mode : 'oauth';
  const appId = (req.body.app_client_id || '').trim() || null, appSecret = (req.body.app_client_secret || '').trim() || null;
  if (mode !== 'token' && !shopify.creds({ app_client_id: appId, app_client_secret: appSecret }).secret) throw new Error('Enter the Client ID and secret from this store\'s app in the Shopify Dev Dashboard');
  const { lastInsertRowid: id } = db.prepare('INSERT INTO stores(client_id,shop,auth_mode,app_client_id,app_client_secret,access_token,api_secret) VALUES(?,?,?,?,?,?,?)')
    .run(int(req.body.client_id), shop, mode, appId, appSecret, mode === 'token' ? req.body.access_token || null : null, req.body.api_secret || null);
  if (mode !== 'oauth') await connectAndSync(id);
  return { id, install_link: `${process.env.APP_URL || ''}/shopify/install?shop=${shop}` };
}));
async function connectAndSync(id) {
  const s = db.prepare('SELECT * FROM stores WHERE id=?').get(id);
  try {
    await shopify.getToken(s);
    await shopify.registerWebhooks(db.prepare('SELECT * FROM stores WHERE id=?').get(id)).catch(e => db.prepare('UPDATE stores SET status_note=? WHERE id=?').run('Webhooks: ' + e.message, id));
    return await shopify.syncStore(db.prepare('SELECT * FROM stores WHERE id=?').get(id), { sinceDays: 14 });
  } catch (e) { db.prepare("UPDATE stores SET status='error', status_note=? WHERE id=?").run(e.message.slice(0, 300), id); throw e; }
}
app.post('/api/stores/:id/sync', wrap(async req => {
  const s = db.prepare('SELECT * FROM stores WHERE id=?').get(req.params.id); if (!s) throw new Error('Not found');
  if (!s.webhooks_registered) return connectAndSync(s.id);
  return shopify.syncStore(s);
}));
app.post('/api/sync-all', wrap(() => shopify.syncAll()));
app.delete('/api/stores/:id', wrap(req => { db.prepare('DELETE FROM stores WHERE id=?').run(req.params.id); return { ok: true }; }));

// Variants from Shopify, with current mapping, for the mapping screen.
app.get('/api/stores/:id/variants', wrap(async req => {
  const s = db.prepare('SELECT * FROM stores WHERE id=?').get(req.params.id); if (!s) throw new Error('Not found');
  const maps = Object.fromEntries(db.prepare('SELECT * FROM variant_map WHERE store_id=?').all(s.id).map(m => [m.variant_id, m]));
  return (await shopify.listVariants(s)).map(v => ({
    id: v.id, sku: v.sku, product: v.product.title, product_id: v.product.id, title: v.title,
    size: (v.selectedOptions.find(o => /size/i.test(o.name)) || {}).value || null,
    colour: (v.selectedOptions.find(o => /colou?r/i.test(o.name)) || {}).value || null,
    map: maps[v.id] || null
  }));
}));

// ---------- Mapping ----------
app.get('/api/unmapped', wrap(() => db.prepare(`
  SELECT o.store_id, s.shop, s.client_id, c.name client, ol.variant_id, ol.sku, ol.title, ol.variant_title,
    SUM(ol.qty) qty, COUNT(DISTINCT o.id) orders
  FROM order_lines ol JOIN orders o ON o.id=ol.order_id JOIN stores s ON s.id=o.store_id JOIN clients c ON c.id=s.client_id
  WHERE ol.processed=0 AND o.cancelled=0 GROUP BY o.store_id, COALESCE(ol.variant_id, ol.sku, ol.title||ol.variant_title) ORDER BY qty DESC`).all()));

app.post('/api/ignore', wrap(req => {
  const { store_id, variant_id, sku, title, variant_title } = req.body;
  const key = variant_id || sku || `${title}|${variant_title || ''}`;
  db.prepare('INSERT OR IGNORE INTO ignored_items(store_id,item_key,label) VALUES(?,?,?)').run(int(store_id), key, `${title || ''} ${variant_title || ''}`.trim());
  return { ok: true, reprocessed: stock.reprocessUnmapped() };
}));
app.post('/api/map', wrap(req => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const save = db.transaction(() => {
    for (const m of items) {
      if (!m.variant_id || !m.store_id) throw new Error('store_id and variant_id required');
      db.prepare('DELETE FROM ignored_items WHERE store_id=? AND item_key=?').run(m.store_id, m.variant_id);
      if (!m.blank_id) { db.prepare('DELETE FROM variant_map WHERE store_id=? AND variant_id=?').run(m.store_id, m.variant_id); continue; }
      db.prepare(`INSERT INTO variant_map(store_id,variant_id,label,blank_id,units) VALUES(?,?,?,?,?)
        ON CONFLICT(store_id,variant_id) DO UPDATE SET blank_id=excluded.blank_id, units=excluded.units, label=COALESCE(excluded.label,label)`)
        .run(m.store_id, m.variant_id, m.label || null, m.blank_id, Math.max(1, int(m.units) || 1));
    }
  });
  save();
  return { ok: true, reprocessed: stock.reprocessUnmapped() };
}));

// ---------- Blanks & stock ----------
app.get('/api/clients/:id/stock', wrap(req => stock.stockFor(int(req.params.id))));

function upsertBlank(clientId, b) {
  const size = stock.normSize(b.size), colour = String(b.colour || '').trim(), style = String(b.style_code || '').trim().toUpperCase();
  if (!style || !colour || !size) throw new Error(`Each blank needs style code, colour and size (got "${style}", "${colour}", "${size}")`);
  const ex = db.prepare('SELECT * FROM blanks WHERE client_id=? AND style_code=? AND colour=? AND size=?').get(clientId, style, colour, size);
  const num = (v, d) => (v === undefined || v === '' || v === null) ? d : Number(v);
  if (ex) {
    db.prepare('UPDATE blanks SET style_name=?,sku=?,unit_cost=?,reorder_point=?,par_level=?,active=1 WHERE id=?')
      .run(b.style_name || ex.style_name, b.sku || ex.sku, num(b.unit_cost, ex.unit_cost), num(b.reorder_point, ex.reorder_point), num(b.par_level, ex.par_level), ex.id);
    return ex.id;
  }
  return db.prepare('INSERT INTO blanks(client_id,style_code,style_name,colour,size,sku,unit_cost,reorder_point,par_level) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(clientId, style, b.style_name || null, colour, size, b.sku || null, num(b.unit_cost, 0), num(b.reorder_point, 2), num(b.par_level, 0)).lastInsertRowid;
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(c => c.trim())) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); if (row.some(c => c.trim())) rows.push(row);
  if (!rows.length) return [];
  const head = rows.shift().map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^colou?r$/, 'colour').replace(/^style$/, 'style_code').replace(/^(quantity|stock|on_hand)$/, 'qty').replace(/^(cost|price)$/, 'unit_cost').replace(/^(par|target)$/, 'par_level').replace(/^reorder$/, 'reorder_point'));
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

app.post('/api/blanks', wrap(req => {
  const clientId = int(req.body.client_id);
  if (!db.prepare('SELECT id FROM clients WHERE id=?').get(clientId)) throw new Error('Pick a client');
  const items = req.body.csv ? parseCsv(req.body.csv) : req.body.items || [req.body];
  // Sizes can be given as a list ("S,M,L,XL") to create a full run in one go.
  const expanded = items.flatMap(b => String(b.size || '').includes(',') || String(b.size || '').includes(' ')
    ? String(b.size).split(/[\s,]+/).filter(Boolean).map(size => ({ ...b, size })) : [b]);
  const run = db.transaction(() => {
    let created = 0, booked = 0;
    for (const b of expanded) {
      const id = upsertBlank(clientId, b); created++;
      const q = int(b.qty);
      if (q) { stock.addMovement(id, q, 'intake', { note: b.note || 'Stock booked in' }); booked += q; }
    }
    return { rows: created, units_booked: booked };
  });
  return run();
}));
app.put('/api/blanks/:id', wrap(req => {
  const b = db.prepare('SELECT * FROM blanks WHERE id=?').get(req.params.id); if (!b) throw new Error('Not found');
  const n = { ...b, ...req.body };
  db.prepare('UPDATE blanks SET style_name=?,sku=?,unit_cost=?,reorder_point=?,par_level=?,active=? WHERE id=?')
    .run(n.style_name, n.sku || null, +n.unit_cost || 0, int(n.reorder_point) || 0, int(n.par_level) || 0, n.active ? 1 : 0, b.id);
  return { ok: true };
}));
// Book stock in / out. mode 'set' records a stock-take count.
app.post('/api/blanks/:id/move', wrap(req => {
  const id = int(req.params.id); const b = db.prepare('SELECT id FROM blanks WHERE id=?').get(id); if (!b) throw new Error('Not found');
  let qty = int(req.body.qty); const kind = ['intake', 'restock', 'adjust'].includes(req.body.kind) ? req.body.kind : 'adjust';
  if (req.body.mode === 'set') qty = qty - stock.onHand(id);
  if (!qty) return { ok: true, on_hand: stock.onHand(id) };
  db.transaction(() => stock.addMovement(id, qty, kind, { note: req.body.note || (req.body.mode === 'set' ? 'Stock take' : null) }))();
  return { ok: true, on_hand: stock.onHand(id) };
}));
app.get('/api/blanks/:id/history', wrap(req => db.prepare('SELECT * FROM movements WHERE blank_id=? ORDER BY id DESC LIMIT 200').all(req.params.id)));

// ---------- Orders ----------
app.get('/api/orders', wrap(req => {
  const where = ['1=1'], args = [];
  if (req.query.client) { where.push('s.client_id=?'); args.push(int(req.query.client)); }
  if (req.query.status === 'blocked') where.push("o.status='new' AND o.cancelled=0 AND EXISTS(SELECT 1 FROM order_lines x WHERE x.order_id=o.id AND (x.short_qty>0 OR x.processed=0))");
  else if (req.query.status === 'ready') where.push("o.status='new' AND o.cancelled=0 AND NOT EXISTS(SELECT 1 FROM order_lines x WHERE x.order_id=o.id AND (x.short_qty>0 OR x.processed=0))");
  else if (req.query.status === 'cancelled') where.push('o.cancelled=1');
  else if (req.query.status) { where.push('o.status=? AND o.cancelled=0'); args.push(req.query.status); }
  if (req.query.q) { where.push('(o.name LIKE ? OR EXISTS(SELECT 1 FROM order_lines x WHERE x.order_id=o.id AND (x.title LIKE ? OR x.sku LIKE ?)))'); args.push(...Array(3).fill(`%${req.query.q}%`)); }
  const orders = db.prepare(`SELECT o.*, s.shop, c.name client, c.id client_id FROM orders o JOIN stores s ON s.id=o.store_id JOIN clients c ON c.id=s.client_id
    WHERE ${where.join(' AND ')} ORDER BY o.placed_at DESC LIMIT ${Math.min(int(req.query.limit) || 300, 1000)}`).all(...args);
  const lines = db.prepare(`SELECT ol.*, b.style_code, b.colour, b.size FROM order_lines ol LEFT JOIN blanks b ON b.id=ol.blank_id WHERE ol.order_id=?`);
  return orders.map(o => { o.lines = lines.all(o.id); o.blocked = !o.cancelled && o.status === 'new' && o.lines.some(l => l.short_qty > 0 || !l.processed); return o; });
}));
app.post('/api/orders/status', wrap(req => {
  const status = req.body.status; if (!['new', 'printed', 'dispatched'].includes(status)) throw new Error('Bad status');
  const upd = db.prepare('UPDATE orders SET status=? WHERE id=?');
  db.transaction(() => (req.body.ids || []).forEach(id => upd.run(status, int(id))))();
  return { ok: true };
}));

// ---------- Top-up invoices ----------
function nextInvoiceNumber() {
  const prefix = getSetting('invoice_prefix', 'TOP-'); let n = int(getSetting('next_invoice', '1')) || 1;
  while (db.prepare('SELECT 1 FROM invoices WHERE number=?').get(prefix + String(n).padStart(4, '0'))) n++;
  setSetting('next_invoice', n + 1);
  return prefix + String(n).padStart(4, '0');
}
app.get('/api/invoices', wrap(req => db.prepare(`SELECT i.id FROM invoices i ${req.query.client ? 'WHERE i.client_id=?' : ''} ORDER BY i.id DESC`)
  .all(...(req.query.client ? [int(req.query.client)] : [])).map(r => { const d = invoiceData(r.id); d.received = d.lines.reduce((s, l) => s + l.received_qty, 0); return d; })));
app.post('/api/invoices', wrap(req => {
  const c = db.prepare('SELECT * FROM clients WHERE id=?').get(int(req.body.client_id)); if (!c) throw new Error('Pick a client');
  const lines = (req.body.lines || []).filter(l => int(l.qty) > 0);
  if (!lines.length) throw new Error('Nothing to invoice');
  return db.transaction(() => {
    const { lastInsertRowid: id } = db.prepare('INSERT INTO invoices(client_id,number,markup_pct,handling_fee,notes) VALUES(?,?,?,?,?)')
      .run(c.id, nextInvoiceNumber(), c.markup_pct, c.handling_fee, req.body.notes || null);
    for (const l of lines) {
      const b = db.prepare('SELECT * FROM blanks WHERE id=? AND client_id=?').get(int(l.blank_id), c.id); if (!b) throw new Error('Blank not found for this client');
      const price = l.unit_price !== undefined && l.unit_price !== '' ? +l.unit_price : Math.round(b.unit_cost * (1 + c.markup_pct / 100) * 100) / 100;
      db.prepare('INSERT INTO invoice_lines(invoice_id,blank_id,qty,unit_price) VALUES(?,?,?,?)').run(id, b.id, int(l.qty), price);
    }
    return { id };
  })();
}));
app.put('/api/invoices/:id', wrap(req => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id); if (!inv) throw new Error('Not found');
  if (req.body.status && !['draft', 'sent', 'paid', 'void'].includes(req.body.status)) throw new Error('Bad status');
  db.prepare('UPDATE invoices SET status=?, notes=? WHERE id=?').run(req.body.status || inv.status, req.body.notes ?? inv.notes, inv.id);
  return { ok: true };
}));
// Blanks for this invoice have arrived from the supplier: book them into stock.
app.post('/api/invoices/:id/receive', wrap(req => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id); if (!inv) throw new Error('Not found');
  const want = req.body.lines ? Object.fromEntries(req.body.lines.map(l => [int(l.id), int(l.qty)])) : null;
  let units = 0;
  db.transaction(() => {
    for (const l of db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?').all(inv.id)) {
      const outstanding = l.qty - l.received_qty;
      const q = Math.min(outstanding, want ? (want[l.id] || 0) : outstanding);
      if (q <= 0) continue;
      db.prepare('UPDATE invoice_lines SET received_qty=received_qty+? WHERE id=?').run(q, l.id);
      stock.addMovement(l.blank_id, q, 'restock', { ref: inv.number, note: 'Top-up received' });
      units += q;
    }
  })();
  return { ok: true, units };
}));
app.get('/invoices/:id.csv', (req, res) => { const c = invoiceCsv(int(req.params.id)); if (!c) return res.status(404).end(); res.type('text/csv').attachment(`invoice-${req.params.id}.csv`).send(c); });
app.get('/invoices/:id', (req, res) => { const h = invoiceHtml(int(req.params.id)); h ? res.type('html').send(h) : res.status(404).send('Not found'); });

// ---------- Front end ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`BlankStock running on http://localhost:${PORT}`);
    if (!process.env.ADMIN_PASSWORD) console.warn('⚠ Set ADMIN_PASSWORD in .env or nobody can log in.');
    if (!process.env.SESSION_SECRET) console.warn('⚠ Set SESSION_SECRET in .env so logins survive restarts.');
  });
  const mins = Number(process.env.SYNC_MINUTES || 10);
  if (mins > 0) setInterval(() => shopify.syncAll().catch(e => console.error('sync', e.message)), mins * 60e3);
}
module.exports = app;
