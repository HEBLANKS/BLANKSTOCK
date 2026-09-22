// SQLite storage. One file, no server to run. Stock is a ledger: every change is a
// movement row, and "on hand" is always the sum of movements — so it can be audited.
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, nothing to compile
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'blankstock.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Small wrapper: treat undefined as NULL, and add transaction() (nest-safe via savepoints).
const clean = args => args.map(a => a === undefined ? null : typeof a === 'boolean' ? Number(a) : a);
let depth = 0;
const db = {
  exec: sql => raw.exec(sql),
  prepare(sql) {
    const st = raw.prepare(sql);
    return { run: (...a) => st.run(...clean(a)), get: (...a) => st.get(...clean(a)), all: (...a) => st.all(...clean(a)) };
  },
  transaction: fn => (...args) => {
    const sp = `sp${depth++}`;
    raw.exec(`SAVEPOINT ${sp}`);
    try { const r = fn(...args); raw.exec(`RELEASE ${sp}`); return r; }
    catch (e) { raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`); throw e; }
    finally { depth--; }
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  markup_pct REAL NOT NULL DEFAULT 0,      -- added to blank cost on top-up invoices
  handling_fee REAL NOT NULL DEFAULT 0,    -- flat fee per top-up invoice
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  shop TEXT NOT NULL UNIQUE,               -- brand.myshopify.com
  auth_mode TEXT NOT NULL DEFAULT 'oauth', -- oauth | client_credentials | token
  app_client_id TEXT,                      -- each brand's store gets its own Dev Dashboard app (custom distribution = 1 store)
  app_client_secret TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,
  api_secret TEXT,                         -- only for legacy 'token' stores (webhook signing secret)
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | connected | error
  status_note TEXT,
  webhooks_registered INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blanks (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  style_code TEXT NOT NULL,                -- e.g. AT001
  style_name TEXT,                         -- e.g. AWDis 150 tee
  colour TEXT NOT NULL,
  size TEXT NOT NULL,
  sku TEXT,                                -- optional: Shopify SKU that should auto-map here
  unit_cost REAL NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 2,
  par_level INTEGER NOT NULL DEFAULT 0,    -- target stock to top back up to
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(client_id, style_code, colour, size)
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY,
  blank_id INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL,                    -- + in, - out
  kind TEXT NOT NULL,                      -- intake | order | cancel | restock | adjust
  ref TEXT,
  note TEXT,
  order_line_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS mv_blank ON movements(blank_id);

CREATE TABLE IF NOT EXISTS variant_map (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,                -- gid://shopify/ProductVariant/123
  label TEXT,
  blank_id INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  units INTEGER NOT NULL DEFAULT 1,        -- blanks consumed per item sold (bundles)
  UNIQUE(store_id, variant_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_id TEXT NOT NULL,
  name TEXT,
  placed_at TEXT,
  status TEXT NOT NULL DEFAULT 'new',      -- new | printed | dispatched
  cancelled INTEGER NOT NULL DEFAULT 0,
  admin_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(store_id, shopify_id)
);

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shopify_line_id TEXT NOT NULL,
  sku TEXT, variant_id TEXT, title TEXT, variant_title TEXT,
  qty INTEGER NOT NULL,
  blank_id INTEGER REFERENCES blanks(id),
  units INTEGER NOT NULL DEFAULT 1,
  short_qty INTEGER NOT NULL DEFAULT 0,    -- blanks we did not have when the order landed
  processed INTEGER NOT NULL DEFAULT 0,    -- stock has been deducted
  UNIQUE(order_id, shopify_line_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft | sent | paid | void
  markup_pct REAL NOT NULL DEFAULT 0,
  handling_fee REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  blank_id INTEGER NOT NULL REFERENCES blanks(id),
  qty INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  received_qty INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ignored_items (store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE, item_key TEXT NOT NULL, label TEXT, PRIMARY KEY(store_id,item_key)); -- products that aren't printed on a tracked blank (caps, stickers…)
CREATE TABLE IF NOT EXISTS oauth_states (nonce TEXT PRIMARY KEY, shop TEXT, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS webhook_log (webhook_id TEXT PRIMARY KEY, topic TEXT, shop TEXT, received_at TEXT DEFAULT (datetime('now')));
`);

const getSetting = (k, d = '') => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value ?? d;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v ?? ''));

module.exports = { db, getSetting, setSetting };
