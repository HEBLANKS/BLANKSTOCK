// Core stock logic: taking orders out of stock, flagging shortfalls, booking stock in,
// and working out what each client needs to be invoiced for.
const { db } = require('./db');

const SIZE_ORDER = ['XXS','XS','S','M','L','XL','2XL','3XL','4XL','5XL','6XL','7XL','8XL','OS'];
const normSize = s => {
  const t = String(s || '').trim().toUpperCase().replace(/^XXL$/, '2XL').replace(/^XXXL$/, '3XL')
    .replace(/^SMALL$/, 'S').replace(/^MEDIUM$/, 'M').replace(/^LARGE$/, 'L')
    .replace(/^X-?LARGE$/, 'XL').replace(/^ONE ?SIZE$/, 'OS');
  return t;
};
const sizeRank = s => { const i = SIZE_ORDER.indexOf(normSize(s)); return i < 0 ? 99 : i; };

const onHand = blankId => db.prepare('SELECT COALESCE(SUM(qty),0) n FROM movements WHERE blank_id=?').get(blankId).n;

// Units already on a (non-void) top-up invoice but not yet booked in.
const onOrder = blankId => db.prepare(`
  SELECT COALESCE(SUM(il.qty - il.received_qty),0) n FROM invoice_lines il
  JOIN invoices i ON i.id=il.invoice_id WHERE il.blank_id=? AND i.status!='void'`).get(blankId).n;

function addMovement(blankId, qty, kind, { ref = null, note = null, orderLineId = null } = {}) {
  db.prepare('INSERT INTO movements(blank_id,qty,kind,ref,note,order_line_id) VALUES(?,?,?,?,?,?)')
    .run(blankId, qty, kind, ref, note, orderLineId);
  if (qty > 0 && kind !== 'cancel') fillShorts(blankId, qty);
}

// New stock goes to back-ordered lines first, oldest order first.
function fillShorts(blankId, n) {
  const lines = db.prepare(`
    SELECT ol.id, ol.short_qty FROM order_lines ol JOIN orders o ON o.id=ol.order_id
    WHERE ol.blank_id=? AND ol.short_qty>0 AND o.cancelled=0 AND o.status='new'
    ORDER BY o.placed_at, o.id`).all(blankId);
  for (const l of lines) {
    if (n <= 0) break;
    const take = Math.min(n, l.short_qty);
    db.prepare('UPDATE order_lines SET short_qty=short_qty-? WHERE id=?').run(take, l.id);
    n -= take;
  }
}

// Work out which blank a Shopify line uses: explicit variant mapping first, then SKU match.
function resolveBlank(storeId, clientId, variantId, sku) {
  if (variantId) {
    const m = db.prepare('SELECT blank_id, units FROM variant_map WHERE store_id=? AND variant_id=?').get(storeId, variantId);
    if (m) return m;
  }
  if (sku) {
    const b = db.prepare('SELECT id FROM blanks WHERE client_id=? AND sku=? AND active=1').get(clientId, sku);
    if (b) return { blank_id: b.id, units: 1 };
  }
  return null;
}

// Deduct stock for one line. Stock may go negative: that negative is the shortfall.
function processLine(lineId) {
  const l = db.prepare(`SELECT ol.*, o.store_id, o.name order_name, o.cancelled, s.client_id
    FROM order_lines ol JOIN orders o ON o.id=ol.order_id JOIN stores s ON s.id=o.store_id WHERE ol.id=?`).get(lineId);
  if (!l || l.processed || l.cancelled) return false;
  const key = l.variant_id || l.sku || `${l.title}|${l.variant_title || ''}`;
  if (db.prepare('SELECT 1 FROM ignored_items WHERE store_id=? AND item_key=?').get(l.store_id, key)) {
    db.prepare('UPDATE order_lines SET processed=1, blank_id=NULL, short_qty=0 WHERE id=?').run(lineId);
    return true;
  }
  const hit = resolveBlank(l.store_id, l.client_id, l.variant_id, l.sku);
  if (!hit) return false;
  const need = l.qty * hit.units;
  const available = Math.max(0, onHand(hit.blank_id));
  const short = Math.max(0, need - available);
  db.prepare('UPDATE order_lines SET blank_id=?, units=?, short_qty=?, processed=1 WHERE id=?')
    .run(hit.blank_id, hit.units, short, lineId);
  addMovement(hit.blank_id, -need, 'order', { ref: l.order_name, orderLineId: lineId });
  return true;
}

// Normalised order: { shopifyId, name, placedAt, cancelled, adminUrl, lines:[{lineId, sku, variantId, title, variantTitle, qty}] }
const ingestOrder = db.transaction((storeId, o) => {
  const existing = db.prepare('SELECT * FROM orders WHERE store_id=? AND shopify_id=?').get(storeId, o.shopifyId);
  if (existing) {
    if (o.cancelled && !existing.cancelled) cancelOrder(existing.id);
    return { id: existing.id, created: false };
  }
  const { lastInsertRowid: orderId } = db.prepare(
    'INSERT INTO orders(store_id,shopify_id,name,placed_at,admin_url,cancelled) VALUES(?,?,?,?,?,0)')
    .run(storeId, o.shopifyId, o.name, o.placedAt, o.adminUrl);
  for (const li of o.lines) {
    if (!li.qty) continue;
    const { lastInsertRowid, changes } = db.prepare(`INSERT OR IGNORE INTO order_lines(order_id,shopify_line_id,sku,variant_id,title,variant_title,qty)
      VALUES(?,?,?,?,?,?,?)`).run(orderId, li.lineId, li.sku, li.variantId, li.title, li.variantTitle, li.qty);
    if (changes) processLine(lastInsertRowid);
  }
  if (o.cancelled) cancelOrder(orderId);
  return { id: orderId, created: true };
});

// Put stock back for a cancelled order (only if it hadn't been printed).
function cancelOrder(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o || o.cancelled) return;
  db.prepare('UPDATE orders SET cancelled=1 WHERE id=?').run(orderId);
  if (o.status !== 'new') return; // already printed: the blank is used, leave the ledger alone
  for (const l of db.prepare('SELECT * FROM order_lines WHERE order_id=? AND processed=1 AND blank_id IS NOT NULL').all(orderId)) {
    addMovement(l.blank_id, l.qty * l.units, 'cancel', { ref: o.name, orderLineId: l.id, note: 'Order cancelled' });
    db.prepare('UPDATE order_lines SET short_qty=0 WHERE id=?').run(l.id);
  }
}

// After a new mapping is saved, pick up any lines that were waiting on it.
const reprocessUnmapped = db.transaction(storeId => {
  const ids = db.prepare(`SELECT ol.id FROM order_lines ol JOIN orders o ON o.id=ol.order_id
    WHERE ol.processed=0 AND o.cancelled=0 ${storeId ? 'AND o.store_id=?' : ''} ORDER BY o.placed_at`)
    .all(...(storeId ? [storeId] : [])).map(r => r.id);
  let n = 0; for (const id of ids) if (processLine(id)) n++;
  return n;
});

// Everything about a client's blanks in one pass.
function stockFor(clientId) {
  const rows = db.prepare(`
    SELECT b.*,
      COALESCE((SELECT SUM(qty) FROM movements m WHERE m.blank_id=b.id),0) on_hand,
      COALESCE((SELECT SUM(il.qty-il.received_qty) FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id
                WHERE il.blank_id=b.id AND i.status!='void'),0) on_order,
      COALESCE((SELECT SUM(-qty) FROM movements m WHERE m.blank_id=b.id AND kind='order' AND created_at>=datetime('now','-30 days')),0) used_30d
    FROM blanks b WHERE b.client_id=? AND b.active=1`).all(clientId);
  for (const r of rows) {
    r.status = r.on_hand < 0 ? 'short' : r.on_hand <= r.reorder_point ? 'low' : 'ok';
    // Suggest enough to cover what we owe plus get back up to par, less anything already on order.
    const target = Math.max(r.par_level, r.reorder_point + 1);
    r.suggest = r.on_hand <= r.reorder_point ? Math.max(0, target - r.on_hand - r.on_order) : Math.max(0, -r.on_hand - r.on_order);
  }
  rows.sort((a, b) => a.style_code.localeCompare(b.style_code) || a.colour.localeCompare(b.colour) || sizeRank(a.size) - sizeRank(b.size));
  return rows;
}

module.exports = { SIZE_ORDER, normSize, sizeRank, onHand, onOrder, addMovement, processLine, ingestOrder, cancelOrder, reprocessUnmapped, stockFor, fillShorts };
