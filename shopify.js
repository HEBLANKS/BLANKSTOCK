// Shopify connection: auth for each brand's store, webhooks, order sync and variant lookup.
const crypto = require('crypto');
const { db } = require('./db');
const { ingestOrder } = require('./stock');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
// Each store can have its own app credentials (a custom-distribution app installs on one store only).
// SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET in .env are the fallback.
const creds = store => ({ id: store?.app_client_id || process.env.SHOPIFY_CLIENT_ID, secret: store?.app_client_secret || process.env.SHOPIFY_CLIENT_SECRET });
const storeByShop = shop => db.prepare('SELECT * FROM stores WHERE shop=?').get(shop);
const APP_URL = () => (process.env.APP_URL || '').replace(/\/$/, '');
const SCOPES = 'read_orders,read_products';

const normShop = s => {
  let v = String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (v && !v.includes('.')) v += '.myshopify.com';
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v) ? v : null;
};
const safeEq = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- OAuth (authorization code grant) for client-owned stores ----------
function installUrl(shop) {
  const nonce = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO oauth_states(nonce,shop,expires_at) VALUES(?,?,?)').run(nonce, shop, Date.now() + 10 * 60e3);
  const { id } = creds(storeByShop(shop));
  if (!id) throw new Error('No app client ID set for this store');
  const q = new URLSearchParams({ client_id: id, scope: SCOPES, redirect_uri: `${APP_URL()}/shopify/callback`, state: nonce });
  return `https://${shop}/admin/oauth/authorize?${q}`;
}

function verifyQueryHmac(query, secret) {
  if (!secret || !query.hmac) return false;
  const { hmac, signature, ...rest } = query;
  const msg = Object.keys(rest).sort().map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  return safeEq(digest, hmac);
}

async function handleCallback(query) {
  const shop = normShop(query.shop);
  if (!shop) throw new Error('Invalid shop');
  const c = creds(storeByShop(shop));
  if (!verifyQueryHmac(query, c.secret)) throw new Error('HMAC check failed');
  const st = db.prepare('SELECT * FROM oauth_states WHERE nonce=?').get(query.state);
  db.prepare('DELETE FROM oauth_states WHERE nonce=? OR expires_at<?').run(query.state, Date.now());
  if (!st || st.shop !== shop || st.expires_at < Date.now()) throw new Error('Install link expired — start again');
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: c.id, client_secret: c.secret, code: query.code })
  });
  if (!r.ok) throw new Error(`Token exchange failed (${r.status}): ${await r.text()}`);
  const t = await r.json();
  db.prepare(`UPDATE stores SET auth_mode='oauth', access_token=?, refresh_token=?, token_expires_at=?, scopes=?, status='connected', status_note=NULL WHERE shop=?`)
    .run(t.access_token, t.refresh_token || null, t.expires_in ? Date.now() + t.expires_in * 1000 : null, t.scope || SCOPES, shop);
  return db.prepare('SELECT * FROM stores WHERE shop=?').get(shop);
}

// ---------- Tokens ----------
async function getToken(store) {
  const fresh = !store.token_expires_at || Date.now() < store.token_expires_at - 60e3;
  if (store.access_token && fresh) return store.access_token;
  let body; const c = creds(store);
  if (store.auth_mode === 'client_credentials') {
    body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret });
  } else if (store.refresh_token) {
    body = new URLSearchParams({ grant_type: 'refresh_token', client_id: c.id, client_secret: c.secret, refresh_token: store.refresh_token });
  } else if (store.access_token) {
    return store.access_token;
  } else {
    throw new Error('Store is not connected yet');
  }
  const r = await fetch(`https://${store.shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Token request failed (${r.status}): ${await r.text()}`);
  const t = await r.json();
  db.prepare(`UPDATE stores SET access_token=?, refresh_token=COALESCE(?,refresh_token), token_expires_at=?, status='connected', status_note=NULL WHERE id=?`)
    .run(t.access_token, t.refresh_token || null, t.expires_in ? Date.now() + t.expires_in * 1000 : null, store.id);
  store.access_token = t.access_token;
  return t.access_token;
}

async function gql(store, query, variables = {}) {
  const token = await getToken(store);
  const r = await fetch(`https://${store.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });
  if (r.status === 429) { await new Promise(res => setTimeout(res, 2000)); return gql(store, query, variables); }
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error('Shopify: ' + j.errors.map(e => e.message).join('; '));
  return j.data;
}

// ---------- Normalising orders from webhooks (REST-shaped) and GraphQL ----------
const adminUrl = (shop, gid) => `https://admin.shopify.com/store/${shop.replace('.myshopify.com', '')}/orders/${String(gid).split('/').pop()}`;

function fromWebhook(shop, p) {
  const gid = p.admin_graphql_api_id || `gid://shopify/Order/${p.id}`;
  return {
    shopifyId: gid, name: p.name, placedAt: p.created_at, cancelled: !!p.cancelled_at, adminUrl: adminUrl(shop, gid),
    lines: (p.line_items || []).map(li => ({
      lineId: li.admin_graphql_api_id || `gid://shopify/LineItem/${li.id}`,
      sku: li.sku || null, variantId: li.variant_id ? `gid://shopify/ProductVariant/${li.variant_id}` : null,
      title: li.title, variantTitle: li.variant_title, qty: li.current_quantity ?? li.quantity
    }))
  };
}

function fromGraphql(shop, n) {
  return {
    shopifyId: n.id, name: n.name, placedAt: n.createdAt, cancelled: !!n.cancelledAt, adminUrl: adminUrl(shop, n.id),
    lines: n.lineItems.nodes.map(li => ({
      lineId: li.id, sku: li.sku, variantId: li.variant?.id || null, title: li.title, variantTitle: li.variantTitle,
      qty: li.currentQuantity ?? li.quantity
    }))
  };
}

// ---------- Pull orders (backfill + safety net if a webhook is missed) ----------
const ORDERS_Q = `query($q:String!,$after:String){ orders(first:50, after:$after, query:$q, sortKey:UPDATED_AT){
  pageInfo{ hasNextPage endCursor }
  nodes{ id name createdAt cancelledAt
    lineItems(first:100){ nodes{ id sku title variantTitle quantity currentQuantity variant{ id } } } } } }`;

async function syncStore(store, { sinceDays = 3 } = {}) {
  const since = store.last_synced_at ? new Date(new Date(store.last_synced_at + 'Z').getTime() - 10 * 60e3) : new Date(Date.now() - sinceDays * 864e5);
  const started = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let after = null, created = 0, seen = 0;
  do {
    const d = await gql(store, ORDERS_Q, { q: `updated_at:>'${since.toISOString()}'`, after });
    for (const n of d.orders.nodes) { seen++; if (ingestOrder(store.id, fromGraphql(store.shop, n)).created) created++; }
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after);
  db.prepare('UPDATE stores SET last_synced_at=?, status=\'connected\', status_note=NULL WHERE id=?').run(started, store.id);
  return { seen, created };
}

async function syncAll() {
  const out = [];
  for (const s of db.prepare("SELECT * FROM stores WHERE access_token IS NOT NULL OR auth_mode='client_credentials'").all()) {
    try { out.push({ shop: s.shop, ...(await syncStore(s)) }); }
    catch (e) { db.prepare("UPDATE stores SET status='error', status_note=? WHERE id=?").run(e.message.slice(0, 300), s.id); out.push({ shop: s.shop, error: e.message }); }
  }
  return out;
}

// ---------- Webhooks ----------
const TOPICS = ['ORDERS_CREATE', 'ORDERS_CANCELLED', 'APP_UNINSTALLED'];
async function registerWebhooks(store) {
  const uri = `${APP_URL()}/webhooks`;
  const existing = await gql(store, `{ webhookSubscriptions(first:50){ nodes{ id topic uri } } }`)
    .catch(() => ({ webhookSubscriptions: { nodes: [] } }));
  const have = new Set(existing.webhookSubscriptions.nodes.filter(n => n.uri === uri).map(n => n.topic));
  for (const topic of TOPICS.filter(t => !have.has(t))) {
    // Newer API versions take `uri`; older ones take `callbackUrl`. Try the new field first.
    const m = f => gql(store, `mutation($topic:WebhookSubscriptionTopic!,$sub:WebhookSubscriptionInput!){ webhookSubscriptionCreate(topic:$topic, webhookSubscription:$sub){ userErrors{ message } } }`,
      { topic, sub: { [f]: uri, format: 'JSON' } });
    let d; try { d = await m('uri'); } catch { d = await m('callbackUrl'); }
    const errs = d.webhookSubscriptionCreate.userErrors;
    if (errs.length && !/already/i.test(errs[0].message)) throw new Error(`Webhook ${topic}: ${errs[0].message}`);
  }
  db.prepare('UPDATE stores SET webhooks_registered=1 WHERE id=?').run(store.id);
}

function verifyWebhook(rawBody, hmacHeader, shop) {
  const store = storeByShop(shop);
  const secrets = [store?.app_client_secret, process.env.SHOPIFY_CLIENT_SECRET, store?.api_secret].filter(Boolean);
  return secrets.some(s => safeEq(crypto.createHmac('sha256', s).update(rawBody).digest('base64'), hmacHeader || ''));
}

async function handleWebhook({ topic, shop, webhookId, body }) {
  if (webhookId) {
    const dup = db.prepare('INSERT OR IGNORE INTO webhook_log(webhook_id,topic,shop) VALUES(?,?,?)').run(webhookId, topic, shop);
    if (!dup.changes) return 'duplicate';
  }
  const store = db.prepare('SELECT * FROM stores WHERE shop=?').get(shop);
  if (!store) return 'unknown store';
  if (topic === 'app/uninstalled') {
    db.prepare("UPDATE stores SET status='error', status_note='App uninstalled from store', access_token=NULL, refresh_token=NULL WHERE id=?").run(store.id);
    return 'uninstalled';
  }
  if (topic === 'orders/create' || topic === 'orders/cancelled') {
    ingestOrder(store.id, fromWebhook(shop, body));
    return 'ok';
  }
  return 'ignored';
}

// ---------- Product variants, for mapping ----------
async function listVariants(store) {
  const out = []; let after = null;
  do {
    const d = await gql(store, `query($after:String){ productVariants(first:250, after:$after){ pageInfo{ hasNextPage endCursor }
      nodes{ id sku title selectedOptions{ name value } product{ id title } } } }`, { after });
    out.push(...d.productVariants.nodes);
    after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
  } while (after);
  return out;
}

module.exports = { creds, API_VERSION, SCOPES, normShop, installUrl, verifyQueryHmac, handleCallback, getToken, gql, syncStore, syncAll, registerWebhooks, verifyWebhook, handleWebhook, listVariants, fromWebhook, fromGraphql };
