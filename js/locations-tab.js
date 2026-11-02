// ============================================================================
// locations-tab.js — set a product's Storage or Sample location by scanning.
//
// Step 1: scan the product — its master code (E366), a POS / alternate code
//   on one of its variants, or a PokPok label (P0003955) when the map file
//   from VHM Scan Verify is loaded (🗺 PokPok ↔ Vrich map → "Map file for
//   Stock Count"; the map turns the label into its product code).
// Step 2: scan the location barcode (A1). It is saved on the product as
//   storage_location or sample_location — the same fields the product card
//   and the Edit Product form show — replacing the old value.
//
// 📌 Same location for the next items: after one location is scanned, every
// next product scan is saved straight to that location (filling one shelf).
// Every save in this session can be undone (puts the old value back).
//
// Firestore cost: ONE write per save (patchProduct) and one per undo — nothing else.
// This tab opens no Firestore listener and does no reads of its own: it uses the
// product list app.js already keeps live for the Products tab (passed in as
// getProducts / onProducts). The map file is read from this device only.
// ============================================================================

import { patchProduct } from "./db.js";
import { findVariantByCode } from "./search.js";
import { toast, escapeHtml } from "./ui-components.js";
import { STORAGE_LOCATIONS, SAMPLE_LOCATIONS } from "./constants.js";

const norm = s => (s || "").toString().replace(/[​⁠﻿­]/g, "").trim().toUpperCase();
// A storage bin code: one or two letters + 1–3 digits (A1, B12, AA3)
const BIN_RE = /^[A-Z]{1,2}-?\d{1,3}$/;
const FIELD = { storage: "storage_location", sample: "sample_location" };
const LS_KEY = "vhminv_loc_";
const lsGet = (k, d) => { try { const v = localStorage.getItem(LS_KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS_KEY + k, JSON.stringify(v)); } catch (e) {} };

// ---- tiny IndexedDB store for the map file (it is a few MB — too big for localStorage) ----
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open("vhminv_loc", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const d = await this.open(); return await new Promise(res => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (e) { return undefined; } },
  async set(k, v) { try { const d = await this.open(); return await new Promise(res => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); } catch (e) { return false; } },
};

// ---- beeps (a barcode scanner user should not need to look at the screen) ----
let actx = null;
function tone(f, d, when = 0) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + when; o.frequency.value = f; g.gain.setValueAtTime(.3, t); g.gain.exponentialRampToValueAtTime(.001, t + d); o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + d); } catch (e) {} }
const beepStep = () => tone(990, .07), beepSaved = () => { tone(1320, .08); tone(1760, .1, .1); }, beepBad = () => { tone(220, .25); tone(180, .3, .28); };
const buzz = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };

export function initLocationsTab(container, { getProducts, onProducts }) {
  const state = {
    products: [],
    byMaster: new Map(),          // MASTER CODE -> product
    mode: lsGet("mode", "storage"),  // "storage" | "sample"
    lock: lsGet("lock", false),      // 📌 keep the location for the next items
    lockedLoc: "",                   // the location the lock is holding
    pending: null,                   // product waiting for its location
    pick: null,                      // { code, products } when one label means several products
    log: [],                         // this session: { product, field, from, to, t }
    map: null,                       // PokPok number -> [sale codes]
    mapInfo: null,
  };

  container.innerHTML = `
    <div class="live-tabs loc-modes">
      <button class="live-tab-btn" data-mode="storage">📦 Storage location · ទីតាំងស្តុក</button>
      <button class="live-tab-btn" data-mode="sample">👕 Sample location · ទីតាំងគំរូ</button>
    </div>
    <div class="scan-box loc-box">
      <div id="loc-step" class="loc-step"></div>
      <input id="loc-input" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" />
      <label class="loc-lock"><input type="checkbox" id="loc-lock" /> 📌 Same location for the next items · ទីតាំងដដែលសម្រាប់ទំនិញបន្ទាប់</label>
      <div class="loc-actions">
        <button type="button" class="btn btn-secondary" id="loc-cancel">Clear · សម្អាត</button>
        <button type="button" class="btn btn-secondary" id="loc-labels">🖨 Print location labels · ព្រីនស្លាកទីតាំង</button>
      </div>
    </div>
    <div id="loc-result"></div>
    <div class="loc-map muted" id="loc-map"></div>
    <div id="loc-log"></div>
  `;

  const $ = sel => container.querySelector(sel);
  const input = $("#loc-input");

  container.querySelectorAll(".loc-modes .live-tab-btn").forEach(btn => {
    btn.onclick = () => { state.mode = btn.dataset.mode; lsSet("mode", state.mode); state.lockedLoc = ""; renderAll(); input.focus(); };
  });
  $("#loc-lock").checked = state.lock;
  $("#loc-lock").onchange = e => { state.lock = e.target.checked; lsSet("lock", state.lock); if (!state.lock) state.lockedLoc = ""; renderStep(); input.focus(); };
  $("#loc-cancel").onclick = () => { state.pending = null; state.pick = null; state.lockedLoc = ""; renderAll(); input.focus(); };
  $("#loc-labels").onclick = printLabels;
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); const v = input.value; input.value = ""; handleScan(v); } });

  // the Products tab's live list (no Firestore listener or read here)
  function useProducts(products) {
    state.products = (products || []).filter(p => !p.deleted);
    state.byMaster = new Map(state.products.map(p => [norm(p.master_code), p]));
    if (state.pending) state.pending = state.products.find(p => p.id === state.pending.id) || null;
    renderResult(); renderLog();
  }
  useProducts(getProducts());
  const unsubscribe = onProducts(useProducts);

  idb.get("map").then(m => { if (m) adoptMap(m); renderMapInfo(); });

  // ---------------- map file (optional: lets PokPok labels be scanned) ----------------
  function adoptMap(m) {
    const map = new Map(), add = (k, sale) => { k = norm(k); if (!k || !sale) return; const a = map.get(k) || map.set(k, []).get(k); if (!a.includes(sale)) a.push(sale); };
    (m.items || []).forEach(it => { const sale = norm(it[7]); add(it[0], sale); add(it[1], sale); if (it[6]) add(it[6], sale); });
    state.map = map; state.mapInfo = { at: m.at, count: (m.items || []).length };
  }
  function renderMapInfo() {
    const el = $("#loc-map");
    el.innerHTML = (state.mapInfo
      ? `🗺 PokPok labels: map from ${escapeHtml(String(state.mapInfo.at).slice(0, 16).replace("T", " "))} (${state.mapInfo.count.toLocaleString()} items) · `
      : `🗺 To scan PokPok labels (P000…), open the map file from VHM Scan Verify · ដើម្បីស្កេនស្លាក PokPok សូមបើកឯកសារផែនទី · `) +
      `<label class="loc-mapbtn">${state.mapInfo ? "Change map file" : "Open map file"}<input type="file" accept=".json,application/json" hidden id="loc-mapfile" /></label>`;
    el.querySelector("#loc-mapfile").onchange = async e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      try {
        const m = JSON.parse(await f.text());
        if (!m || m.schema !== "vhm-stock-map" || !Array.isArray(m.items)) throw new Error("This is not the VHM map file");
        adoptMap(m); await idb.set("map", m); renderMapInfo(); toast("Map file loaded");
      } catch (err) { toast(err.message, "error"); }
      input.focus();
    };
  }

  // ---------------- scanning ----------------
  // product for a scanned code: master code → POS / alternate code → PokPok label via the map
  function findProducts(raw) {
    const code = norm(raw);
    if (!code) return [];
    const m = state.byMaster.get(code);
    if (m) return [m];
    const v = findVariantByCode(state.products, code);
    if (v) return [v.product];
    const sales = state.map && state.map.get(code);
    if (sales) return sales.map(s => state.byMaster.get(s)).filter(Boolean);
    return [];
  }
  const looksLikeLocation = code => {
    const c = norm(code);
    return BIN_RE.test(c) || STORAGE_LOCATIONS.map(norm).includes(c) || SAMPLE_LOCATIONS.map(norm).includes(c);
  };
  // storage bins are saved in capitals (a1 → A1); sample spots are saved as scanned/typed
  const cleanLoc = raw => { const t = (raw || "").toString().replace(/[​⁠﻿­]/g, "").trim(); return state.mode === "storage" || BIN_RE.test(norm(t)) ? norm(t) : t; };

  function handleScan(raw) {
    const code = (raw || "").trim();
    if (!code) return;
    state.pick = null;
    const prods = findProducts(code);

    // waiting for a location: a location wins, unless this is clearly another product (then switch to it)
    if (state.pending) {
      if (looksLikeLocation(code) || !prods.length) { save(state.pending, cleanLoc(code)); return; }
    }
    if (!prods.length) {
      if (looksLikeLocation(code)) {         // a location scanned first: with 📌 it becomes the shelf to fill
        if (state.lock) { state.lockedLoc = cleanLoc(code); beepStep(); renderAll(); return; }
        showError(`Scan the product first, then the location · ស្កេនទំនិញជាមុនសិន បន្ទាប់មកទីតាំង`); return;
      }
      showError(`"${escapeHtml(code)}" is not in VHM Inventory · មិនមានក្នុង VHM Inventory` + (state.map ? "" : "<br><span class='muted'>A PokPok label? Open the map file below.</span>")); return;
    }
    if (prods.length > 1) { state.pick = { code, products: prods }; beepStep(); buzz([60, 40, 60]); renderAll(); return; }
    gotProduct(prods[0]);
  }
  function gotProduct(p) {
    if (state.lock && state.lockedLoc) { save(p, state.lockedLoc); return; }
    state.pending = p; beepStep(); buzz(25); renderAll();
  }

  async function save(product, loc) {
    if (!loc) return;
    const field = FIELD[state.mode], from = product[field] || "";
    state.pending = null;
    if (state.lock) state.lockedLoc = loc;
    if (norm(from) === norm(loc)) { beepSaved(); state.log.unshift({ product, field, from, to: loc, t: new Date(), same: true }); renderAll(); return; }
    try {
      await patchProduct(product.id, { [field]: loc });
      state.log.unshift({ product, field, from, to: loc, t: new Date() });
      beepSaved(); buzz(40);
      toast(`${product.master_code} → ${loc}`);
    } catch (e) {
      beepBad(); buzz([200, 80, 200]);
      toast("Not saved: " + e.message, "error");
      state.pending = product;
    }
    renderAll();
  }

  function showError(html) {
    beepBad(); buzz([200, 80, 200]);
    $("#loc-result").innerHTML = `<div class="loc-msg loc-bad">✗ ${html}</div>`;
    input.focus();
  }

  // ---------------- screen ----------------
  function renderAll() {
    container.querySelectorAll(".loc-modes .live-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === state.mode));
    renderStep(); renderResult(); renderLog();
  }
  function renderStep() {
    const where = state.mode === "storage" ? "storage location · ទីតាំងស្តុក" : "sample location · ទីតាំងគំរូ";
    let html;
    if (state.pending) html = `<b>Step 2 · ជំហានទី 2</b> — scan the ${where} for <b>${escapeHtml(state.pending.master_code)}</b>`;
    else if (state.lock && state.lockedLoc) html = `📌 Filling <b class="loc-big">${escapeHtml(state.lockedLoc)}</b> — scan each product to put it here · ស្កេនទំនិញនីមួយៗ ដើម្បីដាក់នៅទីនេះ`;
    else html = `<b>Step 1 · ជំហានទី 1</b> — scan the product (code, POS code or PokPok label) · ស្កេនទំនិញ`;
    $("#loc-step").innerHTML = html;
    input.placeholder = state.pending ? "Scan location, e.g. A1 · ស្កេនទីតាំង" : "Scan product · ស្កេនទំនិញ";
  }
  function productCard(p, note) {
    const cover = p.images?.[0]?.url || "";
    return `<div class="scan-item-card loc-card">
      ${cover ? `<img class="scan-item-img" src="${escapeHtml(cover)}" alt="" />` : ""}
      <div class="scan-item-body">
        <div><span class="master-code">${escapeHtml(p.master_code)}</span> — ${escapeHtml(p.name || "")}</div>
        <div class="card-locations">
          <span class="loc-chip loc-chip-storage" title="Storage location">📦 ${p.storage_location ? escapeHtml(p.storage_location) : "—"}</span>
          <span class="loc-chip loc-chip-sample" title="Sample location">👕 ${p.sample_location ? escapeHtml(p.sample_location) : "—"}</span>
        </div>
        ${note || ""}
      </div>
    </div>`;
  }
  function renderResult() {
    const el = $("#loc-result");
    if (state.pick) {
      el.innerHTML = `<div class="loc-msg loc-warn">🔀 Label <b>${escapeHtml(state.pick.code)}</b> is on ${state.pick.products.length} products — tap the one in your hand · ចុចទំនិញដែលនៅក្នុងដៃ</div>` +
        `<div class="rec-grid">${state.pick.products.map((p, i) => `<button type="button" class="rec-card loc-pick" data-i="${i}"><div class="rec-body"><strong>${escapeHtml(p.master_code)}</strong><span>${escapeHtml(p.name || "")}</span></div></button>`).join("")}</div>`;
      el.querySelectorAll(".loc-pick").forEach(b => b.onclick = () => { const p = state.pick.products[+b.dataset.i]; state.pick = null; gotProduct(p); input.focus(); });
      return;
    }
    if (state.pending) { el.innerHTML = productCard(state.pending, `<div class="muted">Now scan the location · ឥឡូវស្កេនទីតាំង</div>`); return; }
    const last = state.log[0];
    if (last) {
      const p = state.products.find(x => x.id === last.product.id) || last.product;
      el.innerHTML = `<div class="loc-msg loc-ok">✓ <b>${escapeHtml(p.master_code)}</b> ${last.field === "storage_location" ? "📦" : "👕"} ${last.same ? "already at" : "→"} <b class="loc-big">${escapeHtml(last.to)}</b>${last.from && !last.same ? ` <span class="muted">(was ${escapeHtml(last.from)})</span>` : ""}</div>` + productCard(p);
      return;
    }
    el.innerHTML = "";
  }
  function renderLog() {
    const el = $("#loc-log");
    if (!state.log.length) { el.innerHTML = ""; return; }
    el.innerHTML = `<h3 style="margin-top:20px;">This session · វគ្គនេះ (${state.log.length})</h3>
      <div class="loc-log">${state.log.map((x, i) => `<div class="loc-log-row">
        <span class="master-code">${escapeHtml(x.product.master_code)}</span>
        <span>${x.field === "storage_location" ? "📦" : "👕"} ${x.same ? "" : `${escapeHtml(x.from || "—")} → `}<b>${escapeHtml(x.to)}</b></span>
        <span class="muted">${x.t.toTimeString().slice(0, 5)}</span>
        ${x.same || x.undone ? `<span class="muted">${x.undone ? "undone" : "no change"}</span>` : `<button type="button" class="btn btn-secondary loc-undo" data-i="${i}">Undo · ដកវិញ</button>`}
      </div>`).join("")}</div>`;
    el.querySelectorAll(".loc-undo").forEach(b => b.onclick = async () => {
      const x = state.log[+b.dataset.i]; b.disabled = true;
      try { await patchProduct(x.product.id, { [x.field]: x.from || "" }); x.undone = true; toast(`${x.product.master_code} back to ${x.from || "—"}`); renderLog(); }
      catch (e) { toast("Undo failed: " + e.message, "error"); b.disabled = false; }
    });
  }

  // ---------------- printable location barcodes (Code 128) ----------------
  function printLabels() {
    const txt = prompt("Locations to print (comma or space separated) · ទីតាំងសម្រាប់ព្រីន", lsGet("labels", STORAGE_LOCATIONS.join(", ")));
    if (txt == null) return;
    lsSet("labels", txt);
    const locs = [...new Set(txt.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
    if (!locs.length) return;
    const w = window.open("", "_blank");
    if (!w) { toast("Allow pop-ups to print labels", "error"); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Location labels</title>
      <style>body{font-family:system-ui,sans-serif;margin:10mm}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(60mm,1fr));gap:6mm}
      .l{border:1px dashed #999;border-radius:3mm;padding:3mm;text-align:center;break-inside:avoid}.l b{display:block;font-size:28pt;line-height:1.1}svg{width:100%;height:22mm}
      @media print{.no{display:none}}</style></head><body>
      <p class="no"><button onclick="print()">🖨 Print</button> — each label is a barcode of the location (scan it in VHM Inventory → Locations).</p>
      <div class="g">${locs.map(l => `<div class="l"><b>${escapeHtml(l)}</b><svg class="bc" data-v="${escapeHtml(l)}"></svg></div>`).join("")}</div>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js"><\/script>
      <script>document.querySelectorAll('.bc').forEach(function(s){ JsBarcode(s, s.dataset.v, { format: 'CODE128', displayValue: false, margin: 0, height: 60 }); });<\/script>
      </body></html>`);
    w.document.close();
  }

  renderAll(); renderMapInfo();
  setTimeout(() => input.focus(), 0);
  return () => unsubscribe();
}
