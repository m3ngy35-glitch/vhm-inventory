// ============================================================================
// stock-map.js — the PokPok ↔ Vrich map, read from VHM Scan Verify (Firebase
// project vhm-menu), so a PokPok label (P0003955) can be turned into its
// product code (R215) here.
//
// The VHM Scan upload page publishes the map every time the PokPok list, the
// Vrich stock list, the 🔗 links or the "Same words" change:
//   sv2_meta/stockmap            → { ver, parts, count, at }   (1 small doc)
//   sv2_catalog/map_<ver>_<i>    → the map, gzip-compressed, in 1–2 parts
// This file checks the small doc (1 read per app open) and downloads the
// parts only when the version changed (usually 1–2 reads, a few times a week).
// The map is kept on this device (IndexedDB) between opens. Reading uses an
// anonymous sign-in on vhm-menu — the same read-only access the packing
// phones use — in a separate Firebase app instance, so it never touches this
// app's own login or data.
// ============================================================================

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// VHM Scan Verify's project (public web config — same values as in its pages)
const SCAN_CONFIG = {
  apiKey: "AIzaSyCzA--FJTKl74TI0FRhDNGurnOimZjgja0",
  authDomain: "vhm-menu.firebaseapp.com",
  projectId: "vhm-menu",
  storageBucket: "vhm-menu.firebasestorage.app",
  messagingSenderId: "728781560326",
  appId: "1:728781560326:web:4f88ffa992cb6175f40187",
};
const APP_NAME = "vhm-scan-map";
const CHECK_EVERY_MS = 5 * 60 * 1000;      // re-check the version doc at most every 5 minutes

const norm = s => (s || "").toString().replace(/[​⁠﻿­]/g, "").trim().toUpperCase();
const kv = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open("vhm_stockmap", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const d = await this.open(); return await new Promise(res => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (e) { return undefined; } },
  async set(k, v) { try { const d = await this.open(); return await new Promise(res => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); } catch (e) { return false; } },
};
async function gunzip(u8) {
  if (typeof DecompressionStream === "function") {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  if (!window.pako) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  return new TextDecoder().decode(window.pako.ungzip(u8));
}

let MAP = null, lastCheck = 0, busy = null;
const listeners = new Set();

// number (PokPok code, PokPok barcode or Vrich stock code) -> product codes it belongs to
function buildIndex(m) {
  const idx = new Map(), add = (k, sale) => { k = norm(k); if (!k || !sale) return; const a = idx.get(k) || idx.set(k, []).get(k); if (!a.includes(sale)) a.push(sale); };
  (m.items || []).forEach(it => { const sale = norm(it[7]); add(it[0], sale); add(it[1], sale); if (it[6]) add(it[6], sale); });
  return idx;
}
function adopt(m, source) {
  MAP = { ver: m.ver || "", at: m.at || "", count: (m.items || []).length, source, index: buildIndex(m), raw: m };
  listeners.forEach(fn => { try { fn(MAP); } catch (e) { console.error(e); } });
  return MAP;
}

async function fetchOnline() {
  const app = getApps().find(a => a.name === APP_NAME) || initializeApp(SCAN_CONFIG, APP_NAME);
  const auth = getAuth(app);
  if (!auth.currentUser) { await auth.authStateReady?.(); if (!auth.currentUser) await signInAnonymously(auth); }
  const db = getFirestore(app);
  const ptr = await getDoc(doc(db, "sv2_meta", "stockmap"));
  if (!ptr.exists()) return null;
  const p = ptr.data();
  if (MAP && MAP.ver === p.ver) return MAP;
  const parts = [];
  for (let i = 0; i < (p.parts || 0); i++) {
    const s = await getDoc(doc(db, "sv2_catalog", `map_${p.ver}_${i}`));
    if (!s.exists() || s.data().ver !== p.ver) throw new Error("A newer map is being published — try again in a minute");
    parts.push(s.data().data.toUint8Array());
  }
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; parts.forEach(x => { all.set(x, o); o += x.length; });
  const m = JSON.parse(await gunzip(all));
  if (!m || m.schema !== "vhm-stock-map" || !Array.isArray(m.items) || m.items.length !== p.count) throw new Error("The online map is incomplete");
  m.ver = p.ver;
  await kv.set("map", m);
  return adopt(m, "online");
}

// Load the map: the device copy at once, then the online version if it changed. Never throws.
export function loadStockMap(force) {
  if (busy) return busy;
  busy = (async () => {
    try {
      if (!MAP) { const c = await kv.get("map"); if (c && Array.isArray(c.items)) adopt(c, c.ver ? "online" : "file"); }
      if (force || Date.now() - lastCheck > CHECK_EVERY_MS) { lastCheck = Date.now(); await fetchOnline(); }
    } catch (e) { console.warn("Stock map: could not check VHM Scan for a newer map —", e.message || e); }
    finally { busy = null; }
    return MAP;
  })();
  return busy;
}
// A map file opened by hand (the .json from the upload page) — used when the online map can't be reached
export async function useMapFile(m) {
  if (!m || m.schema !== "vhm-stock-map" || !Array.isArray(m.items)) throw new Error("This is not the VHM map file");
  await kv.set("map", m);
  return adopt(m, "file");
}
export const currentStockMap = () => MAP;
export function onStockMap(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// product codes a scanned number belongs to ([] if unknown)
export function codesForNumber(raw) { return (MAP && MAP.index.get(norm(raw))) || []; }
