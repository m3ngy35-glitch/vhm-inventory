# VHM Inventory

A modular clothing inventory manager for VHM Club — categories, tags,
products with a master code, and a full size × color variant matrix with
POS codes, alternate codes, stock and price. Global instant search across
everything, drag-and-drop photo uploads, inline stock/POS quick-edit.

No server, no database to host, no Docker — it's a set of plain HTML/CSS/JS
files that talk directly to Firebase (Firestore + Storage), the same way
your other VHM tools work. That means you can run it the same way too:
double-click `index.html`, or push this folder to GitHub Pages.

## How it's organized (and why)

Even though there's no backend server, the code is still split by
responsibility so one part can change without risking another:

| File | Job |
|---|---|
| `js/firebase-config.js` | Your Firebase project keys — the only file you normally edit |
| `js/db.js` | **Only** file that talks to Firestore/Storage. Everything else goes through it |
| `js/constants.js` | Sizes, variant types — change once, applies everywhere |
| `js/search.js` | Global search (master code, POS + alternate codes, name, description, tags, category) |
| `js/variant-matrix.js` | Generates size×color variant rows, renders/reads the editable table |
| `js/image-upload.js` | Drag-and-drop photo uploader with reordering |
| `js/product-form.js` | The "New/Edit Product" modal — combines the pieces above |
| `js/category-tag-manager.js` | Manage categories & tags (name + color badge) |
| `js/ui-components.js` | Color badges, toasts, the full-screen photo gallery |
| `js/app.js` | Main page: search bar, filters, product grid, inline quick-edit |
| `js/stock-map.js` | 🔌 Reads the PokPok ↔ Vrich map from VHM Scan Verify (its project, read-only) so PokPok labels work |
| `js/locations-tab.js` | 📍 Locations tab: scan a product, then a location barcode → saves its storage or sample location |
| `js/cycle-tab.js` | 🔄 Cycle tab: logs every Stock → Sample → Live Room → Stock move by scan |

If you want to add a feature later, you almost always only touch one file.

## Setup (10 minutes, one time)

`js/firebase-config.js` is already connected to your **vhm-data** Firebase
project — you don't need to touch that file. What's left:

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
   and open the **vhm-data** project.
2. Turn on, if not already on (Build menu, left sidebar):
   - **Firestore Database** → Create database → production mode
   - **Storage** → Get started
   - **Authentication** → Get started → enable **Email/Password** → add an
     account for yourself and each staff member who'll manage inventory.
     This is what keeps the data editable only by your team.
3. Open **Firestore Database → Rules** tab, replace the contents with
   what's in `firestore.rules` (in this folder), click **Publish**. Do the
   same for **Storage → Rules** with `storage.rules`.
4. Because Authentication is on but this simple version of the app has no
   login screen yet, the easiest path for now is to temporarily sign in
   once from any other page on the vhm-data project that already has a
   login — the browser session carries over. If you'd rather have a proper
   login screen built into this app itself, just ask and I'll add one
   (it's a small addition to `js/app.js`).

## Running it

- **Quickest test:** just open `index.html` in a browser.
- **For your team (recommended):** push this whole folder to a GitHub
  repo and turn on GitHub Pages, the same way `vhm-catalogv2` works —
  then everyone uses the same link, no installs needed.

## Data model

- **Category**: name, color (hex) for the badge shown on product cards.
- **Tag**: name, color (hex) — a product can have many.
- **Product**: master code (e.g. `N500`), name, description, category,
  tags, ordered photo list.
- **Variant** (one row per size × color): type (Shirt/Pants/Accessory),
  size (S–5XL), color name + hex, POS code, alternate codes, stock,
  price. Stored on the product document so each product is a single,
  self-contained Firestore document — this avoids the "shared blob"
  data-loss bug pattern from earlier tools.

## Growing this later

Everything above is intentionally the simplest version that covers the
full spec (search, size matrix, POS codes, images, color badges). If VHM
ever outgrows plain Firestore — very large catalogs needing fuzzy search,
multiple people editing simultaneously at high volume, or a real staff
login/permissions screen — the natural next step is exactly the
Postgres + backend API + Docker setup originally described, hosted on a
small server. That's a bigger commitment (a server to maintain, database
backups, deployments) so it's worth doing only once this lighter version
is actually being used day to day and hits a real limit.

## 📍 Locations tab (scan product → scan location)

1. Choose **📦 Storage location** or **👕 Sample location** at the top.
2. Scan the product: its master code (E366), a POS / alternate code, or a
   PokPok label (P0003955). PokPok labels use the PokPok ↔ Vrich map, which
   loads by itself from VHM Scan Verify (the source — its upload page
   publishes it after every PokPok / Vrich upload). A map file can still be
   opened by hand at the bottom of the tab when there is no internet.
3. Scan the location barcode (B23). It is saved in the same field the
   product card and the Edit Product form show for that location. If the
   code already has a different location there, the app asks "B23 is saved —
   replace with A5?" — nothing is replaced unless staff tap Replace.

**Which field holds what:** staff have always typed the actual stock place
(e.g. B23) into the field stored as `sample_location`, and the sample/display
place into `storage_location`. The screens follow that data (see
`LOCATION_FIELDS` in `js/constants.js`) — nothing was moved or rewritten.

- **📌 Same location for the next items:** scan a location once, then every
  product scanned is saved straight to it — for filling one shelf.
- A label number used by several products (e.g. P0003963) asks which one
  is in your hand.
- **Undo** on each line of "This session" puts the old location back.
- **🖨 Print location labels** makes Code 128 barcodes for A1–A14 (or any
  list you type) to stick on the shelves.

## Firestore reads (kept low on purpose)

- **Product list:** each device keeps the list on the device (IndexedDB)
  and, on open, downloads only products changed since its last sync
  (`db.js → subscribeProducts`). Reopening costs a few reads instead of one
  per product. Once a week it re-reads everything once. All tabs share one
  listener. Every product write sets `updated_at` (archive/restore too) —
  keep it that way in any new write, or other devices won't see the change
  until the weekly full read.
- **📍 Locations tab:** no reads of its own — 1 write per save.

## 🔌 Connection to VHM Scan Verify (the source)

VHM Scan Verify's upload page publishes the PokPok ↔ Vrich map to its own
Firebase project (vhm-menu: `sv2_meta/stockmap` + `sv2_catalog/map_*`)
whenever the PokPok list, the Vrich stock list, the 🔗 links or "Same words"
change. `js/stock-map.js` reads it with an anonymous, read-only sign-in on
vhm-menu (the same access the packing phones use), in a separate Firebase app
— it never touches vhm-data's login or data. Cost: 1 read when the tab is
opened (version check), 1–2 more only when the map changed; the map is kept on
the device. An unknown label triggers one extra check, so a brand-new code
works as soon as the manager has uploaded the lists.

## 🔄 Cycle tab (Sample ⇄ Live Room, Stock when the sample container is full)

Logs every move of a sample piece by scanning:

- Normal cycle: 👕 Sample → 🎥 Live Room → 👕 Sample → … (repeats)
- 📦 Stock is only for when the sample container is full: the extra piece goes to
  Stock as a replacement and later comes back to Sample (or straight to Live).

1. **Choose the station** by tapping its button or scanning its station barcode
   (**🖨 Print station labels** prints `SAMPLE`, `LIVE`, `STOCK` and `NEXT`). The
   device remembers its station, so the live-room scanner can stay on 🎥 Live Room.
   **➡ Next step** mode: each scan flips Sample ⇄ Live; a code in Stock goes to Sample.
2. **Scan each product** as it arrives: master code, POS / alternate code, or PokPok label.
   Each scan logs one move. A move to Stock is logged with reason "sample full" and shows the
   📦 stock place (e.g. B23); a move to Sample shows the 👕 sample spot.

Checks: if a code is already in that stage, nothing is logged and a warning beep plays.
A scanner double beep (the same code within 4 s) is ignored. **Undo** removes the newest move of a code.

- **Board:** what is in Sample, the Live Room and Stock (replacement) right now, and how long
  each piece has been there (longest first). 🎥×N = times the code has gone live. Tap a code
  for its full history.
- **📜 Day log:** every move on a chosen day, with totals and a CSV download.
- The product card also shows a chip with the current stage and time (e.g. 🎥 Live Room · 2h 5m).

Data: `cycle_log` gets one doc per move (from, to, times live, reason, time in the previous
stage, scanned code, size/colour if a POS code was scanned, who, when). The product gets
`cycle_stage`, `cycle_at` and `cycle_round` (= times live).
Cost: each scan is 2 writes in one batch, with no reads. Reads happen only when you open a
history or a day log. No new Firestore index or rule is needed.
