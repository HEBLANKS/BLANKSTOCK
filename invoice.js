// Printable top-up invoice (open in browser → Print → Save as PDF).
const { db, getSetting } = require('./db');
const { sizeRank } = require('./stock');

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => '£' + (Math.round(n * 100) / 100).toFixed(2);

function invoiceData(id) {
  const inv = db.prepare('SELECT i.*, c.name client_name, c.email client_email FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?').get(id);
  if (!inv) return null;
  inv.lines = db.prepare(`SELECT il.*, b.style_code, b.style_name, b.colour, b.size FROM invoice_lines il JOIN blanks b ON b.id=il.blank_id WHERE il.invoice_id=?`).all(id)
    .sort((a, b) => a.style_code.localeCompare(b.style_code) || a.colour.localeCompare(b.colour) || sizeRank(a.size) - sizeRank(b.size));
  inv.subtotal = inv.lines.reduce((s, l) => s + l.qty * l.unit_price, 0) + (inv.handling_fee || 0);
  inv.vat_rate = Number(getSetting('vat_rate', '20')) || 0;
  inv.vat = inv.subtotal * inv.vat_rate / 100;
  inv.total = inv.subtotal + inv.vat;
  inv.units = inv.lines.reduce((s, l) => s + l.qty, 0);
  return inv;
}

function invoiceHtml(id) {
  const inv = invoiceData(id);
  if (!inv) return null;
  const S = k => esc(getSetting(k));
  const rows = inv.lines.map(l => `<tr><td>${esc(l.style_code)} ${esc(l.style_name || '')}</td><td>${esc(l.colour)}</td><td>${esc(l.size)}</td>
    <td class="n">${l.qty}</td><td class="n">${money(l.unit_price)}</td><td class="n">${money(l.qty * l.unit_price)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)} — ${esc(inv.client_name)}</title>
<style>
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:800px;margin:40px auto;padding:0 24px}
h1{font-size:28px;margin:0;letter-spacing:-.02em} .muted{color:#666} .top{display:flex;justify-content:space-between;gap:24px;margin-bottom:32px}
table{width:100%;border-collapse:collapse;margin-top:16px} th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #e5e5e5} th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#666}
.n{text-align:right;font-variant-numeric:tabular-nums} .tot td{border:0;padding:4px 6px} .grand td{font-weight:700;font-size:16px;border-top:2px solid #111}
.box{background:#f6f6f6;padding:12px 14px;border-radius:6px;white-space:pre-line;margin-top:24px}
@media print{body{margin:0} .noprint{display:none}}
</style></head><body>
<p class="noprint"><button onclick="print()">Print / Save as PDF</button></p>
<div class="top"><div><h1>${S('biz_name') || 'Top-up invoice'}</h1><div class="muted" style="white-space:pre-line">${S('biz_address')}</div>
<div class="muted">${S('biz_email')}${getSetting('vat_number') ? '<br>VAT ' + S('vat_number') : ''}</div></div>
<div style="text-align:right"><strong>INVOICE ${esc(inv.number)}</strong><br><span class="muted">${esc(inv.created_at.slice(0, 10))}</span>
<br><br><strong>Bill to</strong><br>${esc(inv.client_name)}<br><span class="muted">${esc(inv.client_email || '')}</span></div></div>
<p>Blank garment top-up for your on-demand stock (${inv.units} units).</p>
${inv.notes ? `<p>${esc(inv.notes)}</p>` : ''}
<table><thead><tr><th>Style</th><th>Colour</th><th>Size</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Total</th></tr></thead><tbody>${rows}</tbody></table>
<table style="width:320px;margin-left:auto">
${inv.handling_fee ? `<tr class="tot"><td>Handling</td><td class="n">${money(inv.handling_fee)}</td></tr>` : ''}
<tr class="tot"><td>Subtotal</td><td class="n">${money(inv.subtotal)}</td></tr>
${inv.vat_rate ? `<tr class="tot"><td>VAT ${inv.vat_rate}%</td><td class="n">${money(inv.vat)}</td></tr>` : ''}
<tr class="tot grand"><td>Total due</td><td class="n">${money(inv.total)}</td></tr></table>
${getSetting('bank_details') ? `<div class="box"><strong>Payment</strong>\n${S('payment_terms')}\n${S('bank_details')}</div>` : ''}
</body></html>`;
}

function invoiceCsv(id) {
  const inv = invoiceData(id);
  if (!inv) return null;
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Invoice', 'Client', 'Style', 'Colour', 'Size', 'Qty', 'Unit price', 'Line total'].map(q).join(',')];
  for (const l of inv.lines) lines.push([inv.number, inv.client_name, `${l.style_code} ${l.style_name || ''}`.trim(), l.colour, l.size, l.qty, l.unit_price.toFixed(2), (l.qty * l.unit_price).toFixed(2)].map(q).join(','));
  return lines.join('\n');
}

module.exports = { invoiceData, invoiceHtml, invoiceCsv };
