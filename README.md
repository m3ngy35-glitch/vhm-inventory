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
