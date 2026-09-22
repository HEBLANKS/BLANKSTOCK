# BlankStock

Tracks the blank garments each client has paid a deposit on, takes them out of stock automatically when an order lands in that client's Shopify store, flags orders you can't print because a size has run out, and builds the top-up invoice for what's missing.

## How it works

- **Blanks are held per client.** Each client has their own stock of each style / colour / size (e.g. `AT001 · Jet Black · M`). Stock is a running ledger — every booking-in, order, cancellation and stock-take is a line, so you can always see why a number is what it is.
- **Orders come in from every store.** Each client's Shopify store sends new and cancelled orders straight to BlankStock (webhooks), and BlankStock also checks every 10 minutes in case one was missed.
- **Each Shopify product variant is mapped to a blank** once (the Mapping screen can auto-match a whole product's sizes in one click). From then on, a sale takes that blank out of the client's stock. Bundles work too (e.g. a 2-pack uses 2 blanks). Non-garment products (caps, stickers) can be marked "Don't track".
- **Short orders are flagged, not lost.** If an order needs a size that's run out, stock goes negative and the order shows as **Blocked** with "2 short". Orders you can print today show as **Ready to print**.
- **Top-ups:** the Top-ups screen works out what each client needs — whatever sold without stock, plus enough to get back up to your target ("par") level, minus anything already on an open invoice — prices it at blank cost + that client's markup + handling fee + VAT, and makes a printable invoice (Print → Save as PDF) and a CSV.
- **When the supplier delivers**, click **Book in** on the invoice. The new blanks go to the blocked orders first (oldest first), so those orders flip to Ready to print.

## Screens

| Screen | What it's for |
|---|---|
| Dashboard | One card per client: open, blocked, units short, sizes low, what needs topping up |
| Orders | Print queue across every store. Filter Ready / Blocked / Printed / Dispatched, bulk-mark printed or dispatched |
| Stock | Size-grid per client, colour-coded (green OK, amber low, red short). Click a cell to book in, stock-take or change reorder/par levels |
| Mapping | Products waiting to be linked to a blank, plus "load a whole store's products" |
| Top-ups | Suggested top-up, create invoice, track sent/paid, book in deliveries |
| Clients & stores | Clients (markup %, handling fee) and their Shopify stores |
| Settings | Your business details for invoices; the URLs to paste into Shopify |

## Setting it up

### 1. Host it (one-off)

It needs to live somewhere with a public `https` address so Shopify can send orders to it, and a disk that survives restarts (the whole database is one file).

The easiest route is **Railway** or **Render**: create a new service from this folder (it has a Dockerfile), add a **volume mounted at `/data`**, and set the environment variables from `.env.example` (`APP_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET`). Expect roughly £5–10 a month. A small VPS running `docker run -p 3000:3000 -v blankstock:/data --env-file .env blankstock` also works.

To try it on your own machine first (Node 22.13 or newer):

```
npm install
cp .env.example .env        # set ADMIN_PASSWORD and SESSION_SECRET
DB_PATH=data/demo.db npm run demo-data   # optional: made-up clients and orders to click around
DB_PATH=data/demo.db npm start           # then open http://localhost:3000
```

### 2. Add a client and their blanks

**Clients & stores → New client.** Set their markup % and handling fee for top-up invoices.

**Stock → Add / book in blanks.** Enter a style, colour, a list of sizes (`S M L XL 2XL`), how many of each you're holding from their deposit, the unit cost, the reorder point and the par level. Or paste a spreadsheet with columns `style_code, style_name, colour, size, qty, unit_cost, reorder_point, par_level`.

### 3. Connect the client's Shopify store (about 5 minutes per store)

Shopify only lets a private ("custom") app install on one store, so each brand gets its own small app. You create them all under your own Shopify developer account.

1. Go to **dev.shopify.com** (log in with your Shopify Partner / developer account) → **Apps → Create app** → start from Dev Dashboard. Name it e.g. "BlankStock – Northside".
2. Create a **version** with:
   - App URL: `https://YOUR-APP/shopify/install`
   - Allowed redirection URL: `https://YOUR-APP/shopify/callback`
   - Scopes: `read_orders, read_products`
   - Embed in Shopify admin: **off**

   Then release it. (Settings in BlankStock shows these exact URLs.)
3. Under **API access → Protected customer data**, request access and tick that you use order data for **order fulfilment / inventory**. Order webhooks don't work until this is done. BlankStock doesn't read customer names or addresses, so you only need the basic level.
4. **Distribution → Custom distribution** → enter the brand's `something.myshopify.com` → generate the install link.
5. In BlankStock: **Clients & stores → Add store**, pick the client, enter their `myshopify.com` address, and paste the app's **Client ID** and **Client secret** (from the app's Settings page in the Dev Dashboard).
6. Send the brand owner the **install link from step 4**. When they approve it, BlankStock gets a key, registers for order notifications, and pulls in the last 14 days of orders. The store shows as **connected**.

If the store is one you own (it's in your own Shopify organisation), choose **"Store is in our Shopify org"** when adding it instead. It connects straight away, with no link to send.

### 4. Map products to blanks

**Mapping → Load products from Shopify.** For each product, choose "Auto-match sizes to… AT001 · Jet Black" and the sizes fill themselves in, then **Save all mappings**. Any orders that were waiting are taken out of stock straight away. New products show up under "Waiting on a mapping" the first time they sell.

Tip: if a brand's Shopify SKUs are consistent, put the SKU on the blank (Stock → click the cell → Shopify SKU) and it will map itself.

## Everyday use

- **Morning:** Orders → *Ready to print*. Print, tick, **Mark printed**; tick again once they're shipped, **Mark dispatched**.
- **Blocked orders** tell you exactly which size is short. Top-ups → create the invoice → send the PDF to the client.
- **When they pay**, set the invoice to *paid* and order the blanks from Ralawise. **When the blanks arrive**, click **Book in**.
- **Stock-take** any time: click a size cell → *Stock take (set count)*.

## Good to know

- A cancelled order puts its blanks back, unless it was already marked printed.
- Refunds and edits made in Shopify after the order was placed aren't read. Use a stock adjustment if a blank comes back.
- Everything is stored in one SQLite file (`/data/blankstock.db` in Docker). Back it up. On Railway/Render, turn on volume backups.
- One shared team password. The Shopify client secrets are stored in the database, so keep it private.
- `npm test` runs the automated checks: stock maths, shortfalls, cancellations, top-ups, Shopify sign-in and webhook signatures.
