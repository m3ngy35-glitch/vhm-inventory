// ============================================================================
// cycle-tab.js — 🔄 log every step of a sample piece's cycle by scanning:
//
//     👕 Sample  ⇄  🎥 Live Room   (the normal cycle, repeats)
//     📦 Stock — only when the sample container is full: the extra piece goes to
//                Stock as a replacement, and comes back to Sample / Live later.
//
// How staff use it:
//   1. Pick the station once (tap a button, or scan its station barcode:
//      STOCK / SAMPLE / LIVE). The station is remembered on this device, so the
//      scanner in the live room just stays on 🎥 Live Room.
//      Or choose "➡ Next step": each scan moves the code one step along the cycle.
//   2. Scan products — master code (E366), POS / alternate code, or PokPok label
//      (P0003955, through the VHM Scan map). Every scan = one logged move.
//
// Checks: scanning a code into the stage it is already in logs nothing (warning
// beep). A move to Stock is logged with reason "sample_full". The same code scanned twice within
// a few seconds (a double beep of the scanner) is ignored.
//
// Data: cycle_log (one doc per move) + cycle_stage / cycle_at / cycle_round on the
// product. Cost: 2 writes per scan (one batch), nothing read. The board below
// uses the product list app.js already keeps live. History / day log read only
// when opened. cycle_round = how many times the code has gone into the Live Room.
// ============================================================================

import { logCycleMove, undoCycleMove, listCycleLogForProduct, listCycleLogBetween } from "./db.js";
import { findVariantByCode } from "./search.js";
import { toast, escapeHtml } from "./ui-components.js";
import { LOCATION_FIELDS } from "./constants.js";
import { loadStockMap, currentStockMap, codesForNumber } from "./stock-map.js";

export const STAGES = {
  STOCK: { icon: "📦", en: "Stock", km: "ស្តុក", cls: "cy-stock" },
  SAMPLE: { icon: "👕", en: "Sample", km: "គំរូ", cls: "cy-sample" },
  LIVE: { icon: "🎥", en: "Live Room", km: "បន្ទប់ Live", cls: "cy-live" },
};
const ORDER = ["SAMPLE", "LIVE", "STOCK"];
// "➡ Next step": Sample ⇄ Live; a replacement in Stock comes back to Sample
const NEXT = { SAMPLE: "LIVE", LIVE: "SAMPLE", STOCK: "SAMPLE" };
// station barcodes (what the printed station labels contain) — a few spellings accepted
const STATION_CODES = {
  STOCK: "STOCK", "STAGE-STOCK": "STOCK", "@STOCK": "STOCK",
  SAMPLE: "SAMPLE", "STAGE-SAMPLE": "SAMPLE", "@SAMPLE": "SAMPLE",
  LIVE: "LIVE", LIVEROOM: "LIVE", "LIVE-ROOM": "LIVE", "STAGE-LIVE": "LIVE", "@LIVE": "LIVE",
  NEXT: "NEXT", "STAGE-NEXT": "NEXT", "@NEXT": "NEXT",
};
const DOUBLE_SCAN_MS = 4000;

const norm = s => (s || "").toString().replace(/[​⁠﻿­]/g, "").trim().toUpperCase();
const LS_KEY = "vhminv_cycle_";
const lsGet = (k, d) => { try { const v = localStorage.getItem(LS_KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS_KEY + k, JSON.stringify(v)); } catch (e) {} };

let actx = null;
function tone(f, d, when = 0) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + when; o.frequency.value = f; g.gain.setValueAtTime(.3, t); g.gain.exponentialRampToValueAtTime(.001, t + d); o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + d); } catch (e) {} }
const beepOk = () => { tone(1320, .08); tone(1760, .1, .1); }, beepWarn = () => { tone(660, .12); tone(660, .12, .18); }, beepBad = () => { tone(220, .25); tone(180, .3, .28); }, beepStep = () => tone(990, .07);
const buzz = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };

export function stageChip(stage, sinceIso) {
  const s = STAGES[stage]; if (!s) return "";
  return `<span class="cy-chip ${s.cls}" title="Cycle: now in ${s.en}">${s.icon} ${s.en}${sinceIso ? ` · ${ago(sinceIso)}` : ""}</span>`;
}
export function ago(isoOrMs) {
  const ms = Date.now() - (typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime());
  if (!isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export function initCycleTab(container, { getProducts, onProducts }) {
  const state = {
    products: [],
    byMaster: new Map(),
    station: lsGet("station", "SAMPLE"),   // STOCK | SAMPLE | LIVE | NEXT
    pick: null,                            // { code, products, variant } when one label = several products
    last: null,                            // last result shown under the scan box
    log: [],                               // this session: { logId, product, from, to, prev, t, skipped, undone }
    lastScan: { code: "", t: 0 },
    boardFilter: "",
  };

  container.innerHTML = `
    <div class="cy-flow" aria-hidden="true">
      <span class="cy-chip cy-sample">👕 Sample</span><span class="cy-arrow">⇄</span><span class="cy-chip cy-live">🎥 Live Room</span>
      <span class="muted cy-side">· <span class="cy-chip cy-stock">📦 Stock</span> only when the sample container is full · ពេលកន្លែងគំរូពេញ</span>
    </div>
    <div class="live-tabs cy-stations">
      ${ORDER.map(k => `<button class="live-tab-btn" data-st="${k}">${STAGES[k].icon} ${STAGES[k].en} · ${STAGES[k].km}</button>`).join("")}
      <button class="live-tab-btn" data-st="NEXT">➡ Next step · ជំហានបន្ទាប់</button>
    </div>
    <div class="scan-box loc-box">
      <div id="cy-step" class="loc-step"></div>
      <input id="cy-input" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" placeholder="Scan product · ស្កេនទំនិញ" />
      <div class="loc-actions">
        <button type="button" class="btn btn-secondary" id="cy-labels">🖨 Print station labels · ព្រីនស្លាកស្ថានីយ</button>
        <button type="button" class="btn btn-secondary" id="cy-day">📜 Day log · កំណត់ត្រាប្រចាំថ្ងៃ</button>
      </div>
    </div>
    <div id="cy-result"></div>
    <div id="cy-log"></div>
    <h3 style="margin-top:24px;">Where every piece is now · ទីតាំងបច្ចុប្បន្ន</h3>
    <input id="cy-filter" class="cy-filter" type="search" placeholder="Filter by code · ស្វែងរកកូដ" />
    <div id="cy-board" class="cy-board"></div>
  `;
  const $ = s => container.querySelector(s);
  const input = $("#cy-input");

  container.querySelectorAll(".cy-stations .live-tab-btn").forEach(b => b.onclick = () => setStation(b.dataset.st));
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); const v = input.value; input.value = ""; handleScan(v); } });
  $("#cy-labels").onclick = printStationLabels;
  $("#cy-day").onclick = () => openDayLog();
  $("#cy-filter").oninput = e => { state.boardFilter = norm(e.target.value); renderBoard(); };

  function useProducts(products) {
    state.products = (products || []).filter(p => !p.deleted);
    state.byMaster = new Map(state.products.map(p => [norm(p.master_code), p]));
    renderBoard(); renderResult();
  }
  useProducts(getProducts());
  const unsub = onProducts(useProducts);
  loadStockMap();
  // keep the "time in stage" numbers on the board fresh
  const ticker = setInterval(() => { if (!container.closest("[hidden]")) renderBoard(); }, 60000);

  function setStation(st) {
    state.station = st; lsSet("station", st); state.pick = null;
    state.lastScan = { code: "", t: 0 };          // a new station = the next scan of the same code is a real move
    renderStations(); renderStep(); input.focus();
  }

  // ---------------- scanning ----------------
  function findProducts(raw) {
    const code = norm(raw);
    if (!code) return { list: [] };
    const m = state.byMaster.get(code);
    if (m) return { list: [m] };
    const v = findVariantByCode(state.products, code);
    if (v) return { list: [v.product], variant: v.variant };
    return { list: codesForNumber(code).map(s => state.byMaster.get(s)).filter(Boolean) };
  }

  async function handleScan(raw, retried) {
    const code = norm(raw);
    if (!code) return;
    // a station barcode switches the station
    if (STATION_CODES[code]) { setStation(STATION_CODES[code]); beepStep(); buzz(25); toast(`Station: ${STATION_CODES[code] === "NEXT" ? "➡ Next step" : STAGES[STATION_CODES[code]].icon + " " + STAGES[STATION_CODES[code]].en}`); return; }
    // the scanner's double beep: same code again within a few seconds = ignore
    if (code === state.lastScan.code && Date.now() - state.lastScan.t < DOUBLE_SCAN_MS) return;
    state.pick = null;
    let found = findProducts(code);
    if (!found.list.length && !retried) {         // maybe a brand-new PokPok label: check for a newer map once
      const before = currentStockMap() && currentStockMap().ver;
      await loadStockMap(true);
      if (currentStockMap() && currentStockMap().ver !== before) return handleScan(raw, true);
    }
    if (!found.list.length) {
      const known = codesForNumber(code);
      return showError(known.length
        ? `Label ${escapeHtml(code)} is <b>${known.map(escapeHtml).join(", ")}</b>, but that code is not in VHM Inventory yet · មិនទាន់មានក្នុង VHM Inventory`
        : `"${escapeHtml(code)}" is not in VHM Inventory · មិនមានក្នុង VHM Inventory`);
    }
    if (found.list.length > 1) { state.pick = { code, products: found.list }; beepStep(); buzz([60, 40, 60]); renderResult(); return; }
    state.lastScan = { code, t: Date.now() };
    move(found.list[0], code, found.variant);
  }

  async function move(product, scanned, variant) {
    const p = state.products.find(x => x.id === product.id) || product;
    const from = p.cycle_stage || null;
    const to = state.station === "NEXT" ? (from ? NEXT[from] : "SAMPLE") : state.station;
    if (from === to) {
      beepWarn(); buzz([60, 40, 60]);
      state.last = { kind: "same", product: p, to };
      renderResult(); input.focus(); return;
    }
    const skipped = false;                       // every move between Sample, Live and Stock is allowed
    const prevRound = Number(p.cycle_round) || 0;
    const round = to === "LIVE" ? prevRound + 1 : prevRound;   // = times this code has gone to the Live Room
    const prev = { cycle_stage: p.cycle_stage ?? null, cycle_at: p.cycle_at ?? null, cycle_round: p.cycle_round ?? 0 };
    const mv = {
      from, to, round, skipped, scanned,
      reason: to === "STOCK" ? "sample_full" : "",
      station: state.station,
      in_from_ms: p.cycle_at ? Date.now() - new Date(p.cycle_at).getTime() : null,   // how long it sat in the previous stage
      variant: variant ? { size: variant.size || "", color: variant.color_name || "", pos: variant.pos_code || "" } : null,
    };
    // show it at once; the save finishes in the background (works offline too — Firestore queues it)
    const entry = { logId: null, product: p, from, to, prev, t: new Date(), skipped, round, inFor: mv.in_from_ms, saving: true };
    state.log.unshift(entry);
    state.last = { kind: "moved", entry };
    if (skipped) { beepWarn(); buzz([60, 40, 60]); } else { beepOk(); buzz(40); }
    renderResult(); renderLog(); input.focus();
    try {
      entry.logId = await logCycleMove(p, mv);
      entry.saving = false;
    } catch (e) {
      entry.saving = false; entry.failed = true;
      state.lastScan = { code: "", t: 0 };        // let staff scan it again straight away
      beepBad(); buzz([200, 80, 200]);
      toast("Not saved: " + e.message, "error");
    }
    renderLog(); renderResult();
  }

  function showError(html) {
    beepBad(); buzz([200, 80, 200]);
    state.last = null;
    $("#cy-result").innerHTML = `<div class="loc-msg loc-bad">✗ ${html}</div>`;
    input.focus();
  }

  // ---------------- screen ----------------
  function renderStations() {
    container.querySelectorAll(".cy-stations .live-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.st === state.station));
  }
  function renderStep() {
    const st = state.station;
    $("#cy-step").innerHTML = st === "NEXT"
      ? `<b>➡ Next step</b> — each scan flips the code: 👕 Sample ⇄ 🎥 Live (📦 Stock → 👕 Sample) · ស្កេនម្តង = ទៅជំហានបន្ទាប់`
      : `Station <b class="loc-big">${STAGES[st].icon} ${STAGES[st].en}</b> — scan each product arriving here · ស្កេនទំនិញដែលមកដល់ ${STAGES[st].km}`;
  }
  function whereToPut(p, stage) {
    if (stage === "STOCK") return `<div>Sample container full → kept in Stock as a replacement · កន្លែងគំរូពេញ ទុកក្នុងស្តុក</div>` + (p[LOCATION_FIELDS.stock] ? `<div>Put at 📦 <b class="loc-big">${escapeHtml(p[LOCATION_FIELDS.stock])}</b> · ដាក់នៅ</div>` : "");
    if (stage === "SAMPLE" && p[LOCATION_FIELDS.sample]) return `<div>Sample spot 👕 <b class="loc-big">${escapeHtml(p[LOCATION_FIELDS.sample])}</b></div>`;
    return "";
  }
  function card(p, extra) {
    const cover = p.images?.[0]?.url || "";
    return `<div class="scan-item-card loc-card">
      ${cover ? `<img class="scan-item-img" src="${escapeHtml(cover)}" alt="" />` : ""}
      <div class="scan-item-body">
        <div><span class="master-code">${escapeHtml(p.master_code)}</span> — ${escapeHtml(p.name || "")}</div>
        ${extra || ""}
        <div><a href="#" class="loc-mapbtn cy-hist" data-id="${escapeHtml(p.id)}">History · ប្រវត្តិ</a></div>
      </div>
    </div>`;
  }
  function renderResult() {
    const el = $("#cy-result");
    if (state.pick) {
      el.innerHTML = `<div class="loc-msg loc-warn">🔀 Label <b>${escapeHtml(state.pick.code)}</b> is on ${state.pick.products.length} products — tap the one in your hand · ចុចទំនិញដែលនៅក្នុងដៃ</div>` +
        `<div class="rec-grid">${state.pick.products.map((p, i) => `<button type="button" class="rec-card loc-pick" data-i="${i}"><div class="rec-body"><strong>${escapeHtml(p.master_code)}</strong><span>${escapeHtml(p.name || "")}</span></div></button>`).join("")}</div>`;
      el.querySelectorAll(".loc-pick").forEach(b => b.onclick = () => { const p = state.pick.products[+b.dataset.i], code = state.pick.code; state.pick = null; state.lastScan = { code, t: Date.now() }; move(p, code); });
      return;
    }
    const L = state.last;
    if (!L) { el.innerHTML = ""; return; }
    if (L.kind === "same") {
      const p = state.products.find(x => x.id === L.product.id) || L.product;
      el.innerHTML = `<div class="loc-msg loc-warn">⚠ <b>${escapeHtml(p.master_code)}</b> is already in ${STAGES[L.to].icon} <b>${STAGES[L.to].en}</b> (since ${ago(p.cycle_at)}) — nothing logged · មាននៅទីនេះរួចហើយ</div>` + card(p, whereToPut(p, L.to));
    } else {
      const x = L.entry, p = state.products.find(q => q.id === x.product.id) || x.product, s = STAGES[x.to];
      const fromTxt = x.from ? `${STAGES[x.from].icon} ${STAGES[x.from].en}${x.inFor != null ? ` <span class="muted">(${ago(Date.now() - x.inFor)} there)</span>` : ""} → ` : "";
      const status = x.failed ? `<div class="loc-msg loc-bad" style="margin-top:6px">✗ Not saved — scan again · មិនបានរក្សាទុក</div>` : x.saving ? `<span class="muted">saving…</span>` : "";
      el.innerHTML = `<div class="loc-msg ${x.failed ? "loc-bad" : x.skipped ? "loc-warn" : "loc-ok"}">${x.failed ? "✗" : x.skipped ? "⚠" : "✓"} <b>${escapeHtml(p.master_code)}</b> ${fromTxt}<b class="loc-big">${s.icon} ${s.en}</b> ${x.round ? `<span class="muted">· 🎥 live ×${x.round}</span>` : ""}${status}</div>` + card(p, whereToPut(p, x.to));
    }
    el.querySelectorAll(".cy-hist").forEach(a => a.onclick = e => { e.preventDefault(); openHistory(a.dataset.id); });
  }
  function renderLog() {
    const el = $("#cy-log");
    if (!state.log.length) { el.innerHTML = ""; return; }
    el.innerHTML = `<h3 style="margin-top:20px;">This session · វគ្គនេះ (${state.log.length})</h3>
      <div class="loc-log">${state.log.slice(0, 60).map((x, i) => `<div class="loc-log-row${x.skipped ? " cy-row-skip" : ""}">
        <span class="master-code">${escapeHtml(x.product.master_code)}</span>
        <span>${x.from ? STAGES[x.from].icon + " → " : ""}${STAGES[x.to].icon} <b>${STAGES[x.to].en}</b>${x.skipped ? " ⚠" : ""}</span>
        <span class="muted">${hhmm(x.t.getTime())}</span>
        ${x.undone ? `<span class="muted">undone</span>` : x.failed ? `<span class="muted">not saved</span>` : x.saving ? `<span class="muted">saving…</span>` : `<button type="button" class="btn btn-secondary cy-undo" data-i="${i}">Undo · ដកវិញ</button>`}
      </div>`).join("")}</div>`;
    el.querySelectorAll(".cy-undo").forEach(b => b.onclick = async () => {
      const x = state.log[+b.dataset.i]; b.disabled = true;
      // only the newest move of a code can be undone safely (an older one would put back a stale stage)
      const newer = state.log.find(y => y !== x && y.product.id === x.product.id && !y.undone && !y.failed && y.t > x.t);
      if (newer) { toast(`Undo the newer ${x.product.master_code} move first`, "error"); b.disabled = false; return; }
      try { await undoCycleMove(x.logId, x.product.id, x.prev); x.undone = true; if (state.last?.entry === x) state.last = null; state.lastScan = { code: "", t: 0 }; toast(`${x.product.master_code} back to ${x.prev.cycle_stage ? STAGES[x.prev.cycle_stage].en : "—"}`); renderLog(); renderResult(); }
      catch (e) { toast("Undo failed: " + e.message, "error"); b.disabled = false; }
    });
  }
  function renderBoard() {
    const el = $("#cy-board"), f = state.boardFilter;
    const cols = ORDER.map(k => {
      const items = state.products.filter(p => p.cycle_stage === k && (!f || norm(p.master_code).includes(f)))
        .sort((a, b) => new Date(a.cycle_at) - new Date(b.cycle_at));   // longest there first
      return `<div class="cy-col ${STAGES[k].cls}">
        <div class="cy-col-head">${STAGES[k].icon} ${STAGES[k].en} · ${STAGES[k].km}${k === "STOCK" ? " <span class='muted'>(replacement)</span>" : ""} <b>${items.length}</b></div>
        ${items.length ? items.slice(0, 200).map(p => `<button type="button" class="cy-item" data-id="${escapeHtml(p.id)}"><span class="master-code">${escapeHtml(p.master_code)}</span><span class="muted">${ago(p.cycle_at)}</span>${Number(p.cycle_round) ? `<span class="muted" title="Times in the Live Room">🎥×${Number(p.cycle_round)}</span>` : ""}</button>`).join("") : `<div class="muted cy-empty">—</div>`}
      </div>`;
    }).join("");
    el.innerHTML = cols;
    el.querySelectorAll(".cy-item").forEach(b => b.onclick = () => openHistory(b.dataset.id));
  }

  // ---------------- history of one code ----------------
  async function openHistory(productId) {
    const p = state.products.find(x => x.id === productId);
    const ov = modal(`History · ប្រវត្តិ — ${escapeHtml(p?.master_code || "")}`, `<p class="muted">Loading…</p>`);
    try {
      const rows = await listCycleLogForProduct(productId);
      const lives = rows.filter(r => r.to === "LIVE").length;
      ov.body.innerHTML = rows.length
        ? `<p class="muted">${rows.length} moves · 🎥 in the Live Room ${lives}× · now ${p?.cycle_stage ? STAGES[p.cycle_stage].icon + " " + STAGES[p.cycle_stage].en : "—"}</p>${logTable(rows, false)}`
        : `<p class="muted">No moves logged for this code yet.</p>`;
    } catch (e) { ov.body.innerHTML = `<div class="loc-msg loc-bad">✗ ${escapeHtml(e.message)}</div>`; }
  }

  // ---------------- day log (+ CSV) ----------------
  async function openDayLog(dayStr) {
    const today = new Date(); const pad = n => String(n).padStart(2, "0");
    dayStr = dayStr || `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const ov = modal(`Day log · កំណត់ត្រាប្រចាំថ្ងៃ`, ``);
    ov.body.innerHTML = `<div class="loc-actions"><input type="date" id="cy-date" value="${dayStr}" /><button class="btn btn-secondary" id="cy-csv" disabled>⬇ CSV</button></div><div id="cy-dayrows"><p class="muted">Loading…</p></div>`;
    const load = async () => {
      const d = ov.body.querySelector("#cy-date").value; if (!d) return;
      const [y, m, dd] = d.split("-").map(Number), start = new Date(y, m - 1, dd).getTime(), end = start + 864e5;
      const box = ov.body.querySelector("#cy-dayrows"), csvBtn = ov.body.querySelector("#cy-csv");
      box.innerHTML = `<p class="muted">Loading…</p>`; csvBtn.disabled = true;
      try {
        const rows = await listCycleLogBetween(start, end);
        const count = k => rows.filter(r => r.to === k).length;
        box.innerHTML = rows.length
          ? `<p class="muted">${rows.length} moves · to 🎥 Live ${count("LIVE")} · to 👕 Sample ${count("SAMPLE")} · to 📦 Stock (sample full) ${count("STOCK")}</p>${logTable(rows, true)}`
          : `<p class="muted">No moves on this day.</p>`;
        csvBtn.disabled = !rows.length;
        csvBtn.onclick = () => downloadCsv(rows, d);
      } catch (e) { box.innerHTML = `<div class="loc-msg loc-bad">✗ ${escapeHtml(e.message)}</div>`; }
    };
    ov.body.querySelector("#cy-date").onchange = load;
    load();
  }
  function logTable(rows, withCode) {
    return `<div class="cy-table-wrap"><table class="variant-inline-table cy-table"><thead><tr><th>Time</th>${withCode ? "<th>Code</th>" : ""}<th>Move</th><th>Was there</th><th>Live #</th><th>By</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.skipped ? "cy-row-skip" : ""}">
        <td data-label="Time">${new Date(r.at_ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        ${withCode ? `<td data-label="Code"><span class="master-code">${escapeHtml(r.master_code)}</span></td>` : ""}
        <td data-label="Move">${r.from ? STAGES[r.from]?.icon + " → " : ""}${STAGES[r.to]?.icon || ""} ${STAGES[r.to]?.en || escapeHtml(r.to)}${r.skipped ? " ⚠" : ""}</td>
        <td data-label="Was there">${r.in_from_ms != null ? ago(Date.now() - r.in_from_ms) : "—"}</td>
        <td data-label="Live #">${r.round ?? ""}</td>
        <td data-label="By" class="muted">${escapeHtml((r.by || "").split("@")[0])}</td>
      </tr>`).join("")}</tbody></table></div>`;
  }
  function downloadCsv(rows, day) {
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["time", "code", "from", "to", "minutes_in_previous_stage", "times_live", "reason", "scanned", "size", "color", "by"];
    const lines = rows.slice().reverse().map(r => [new Date(r.at_ms).toISOString(), r.master_code, r.from || "", r.to, r.in_from_ms != null ? Math.round(r.in_from_ms / 60000) : "", r.round, r.reason || "", r.scanned, r.variant?.size, r.variant?.color, r.by].map(esc).join(","));
    const blob = new Blob(["﻿" + [head.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `vhm-cycle-log-${day}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function modal(title, html) {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = `<div class="modal"><div class="modal-header"><h2>${title}</h2><button class="btn-icon modal-close">&times;</button></div><div class="modal-body">${html}</div></div>`;
    document.body.appendChild(ov);
    const close = () => { ov.remove(); input.focus(); };
    ov.querySelector(".modal-close").onclick = close;
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    return { el: ov, body: ov.querySelector(".modal-body") };
  }

  // ---------------- printable station barcodes ----------------
  function printStationLabels() {
    const w = window.open("", "_blank");
    if (!w) { toast("Allow pop-ups to print labels", "error"); return; }
    const labels = [...ORDER.map(k => ({ v: k, t: `${STAGES[k].icon} ${STAGES[k].en}`, km: STAGES[k].km })), { v: "NEXT", t: "➡ Next step", km: "ជំហានបន្ទាប់" }];
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Station labels</title>
      <style>body{font-family:system-ui,sans-serif;margin:10mm}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(80mm,1fr));gap:8mm}
      .l{border:1px dashed #999;border-radius:3mm;padding:4mm;text-align:center;break-inside:avoid}.l b{display:block;font-size:26pt;line-height:1.2}.l i{display:block;font-style:normal;font-size:14pt}svg{width:100%;height:24mm}
      @media print{.no{display:none}}</style></head><body>
      <p class="no"><button onclick="print()">🖨 Print</button> — stick each one at its station. Scanning it in VHM Inventory → 🔄 Cycle switches the station.</p>
      <div class="g">${labels.map(l => `<div class="l"><b>${l.t}</b><i>${l.km}</i><svg class="bc" data-v="${l.v}"></svg></div>`).join("")}</div>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js"><\/script>
      <script>document.querySelectorAll('.bc').forEach(function(s){ JsBarcode(s, s.dataset.v, { format: 'CODE128', displayValue: true, fontSize: 14, margin: 0, height: 60 }); });<\/script>
      </body></html>`);
    w.document.close();
  }

  renderStations(); renderStep(); renderBoard();
  setTimeout(() => input.focus(), 0);
  return () => { unsub(); clearInterval(ticker); };
}
