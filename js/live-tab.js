// ============================================================================
// live-tab.js — daily rotation between showroom (Live) and storage.
//
// Scan Out: staff scans the POS code of an item currently on the live/
//   showroom floor. The app shows what it is, and recommends other
//   in-storage items that share its category + tags — what to bring out
//   next. "Mark as Shown" flips that variant to status SHOWN.
//
// Scan In: staff scans the POS code of an item going back to storage,
//   then scans/enters the storage bin location (A1–A14 etc). Confirming
//   sets that variant to status STORED with that location, so its
//   location is known going forward.
//
// Barcode scanners behave like a keyboard (type the code + Enter), so
// every scan field here just needs to be focused and listen for Enter.
// ============================================================================

import { subscribeProducts, listCategories, listTags, patchVariant } from "./db.js";
import { findVariantByCode } from "./search.js";
import { badge, toast, escapeHtml } from "./ui-components.js";
import { STORAGE_LOCATIONS } from "./constants.js";

// An item counts as due for rotation once it's been sitting SHOWN (out on
// the live/showroom floor) for this many days — the point is to keep the
// floor moving instead of the same pieces sitting out indefinitely.
const ROTATION_DAYS = 7;

export function initLiveTab(container) {
  const state = {
    products: [],
    categoriesById: {},
    tagsById: {},
    mode: "out", // "out" | "in" | "rotate"
    scanOutFound: null, // { product, variant, variantIndex }
    scanInFound: null,
    shellBuilt: null, // which mode's input/shell is currently in the DOM
  };

  container.innerHTML = `
    <div class="live-tabs">
      <button class="live-tab-btn active" data-mode="out">Scan Out (to Live)</button>
      <button class="live-tab-btn" data-mode="in">Scan In (to Storage)</button>
      <button class="live-tab-btn" data-mode="rotate">Needs Rotation<span id="rotate-count-badge"></span></button>
    </div>
    <div id="live-panel"></div>
  `;

  const panel = container.querySelector("#live-panel");

  container.querySelectorAll(".live-tab-btn").forEach(btn => {
    btn.onclick = () => {
      state.mode = btn.dataset.mode;
      container.querySelectorAll(".live-tab-btn").forEach(b => b.classList.toggle("active", b === btn));
      state.scanOutFound = null;
      state.scanInFound = null;
      state.shellBuilt = null; // force the input/shell to rebuild for the new mode
      render();
    };
  });

  Promise.all([listCategories(), listTags()]).then(([cats, tags]) => {
    state.categoriesById = Object.fromEntries(cats.map(c => [c.id, c]));
    state.tagsById = Object.fromEntries(tags.map(t => [t.id, t]));
    render();
  });

  const unsubscribeProducts = subscribeProducts(products => {
    state.products = products;
    // keep any "found" item pointing at fresh data (stock/location can
    // change from another device while this screen is open)
    if (state.scanOutFound) {
      const fresh = findVariantByCode(products, state.scanOutFound.variant.pos_code);
      if (fresh) state.scanOutFound = fresh;
    }
    if (state.scanInFound) {
      const fresh = findVariantByCode(products, state.scanInFound.variant.pos_code);
      if (fresh) state.scanInFound = fresh;
    }
    render();
  });

  // IMPORTANT: this fires on every Firestore update, including from other
  // staff devices, possibly mid-keystroke while someone is scanning a
  // code here. So render() must NOT rebuild the input field itself once
  // it exists — only the shell (input) changes on a mode switch; a data
  // refresh only ever touches the *Result containers below it. "Needs
  // Rotation" has no input field to protect, so it just re-renders fully
  // every time — that's what keeps its day-counts current.
  function render() {
    updateRotateCountBadge();
    if (state.mode === "rotate") {
      renderRotate();
      return;
    }
    if (state.shellBuilt !== state.mode) {
      if (state.mode === "out") renderScanOut();
      else renderScanIn();
      state.shellBuilt = state.mode;
    } else {
      if (state.mode === "out") renderScanOutResult();
      else renderScanInResult();
    }
  }

  function daysSince(isoDate) {
    return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
  }

  // Every SHOWN variant with a shown_at date, newest-out-first... actually
  // longest-out-first, since those are the most urgent to bring back.
  function getRotationItems() {
    const items = [];
    for (const p of state.products) {
      (p.variants || []).forEach((v, i) => {
        if ((v.status || "STORED") === "SHOWN" && v.shown_at) {
          items.push({ product: p, variant: v, variantIndex: i, days: daysSince(v.shown_at) });
        }
      });
    }
    return items.filter(it => it.days >= ROTATION_DAYS).sort((a, b) => b.days - a.days);
  }

  function updateRotateCountBadge() {
    const badge_ = container.querySelector("#rotate-count-badge");
    if (!badge_) return;
    const n = getRotationItems().length;
    badge_.textContent = n ? ` (${n})` : "";
    badge_.classList.toggle("rotate-count-due", n > 0);
  }

  // ---------------- Scan Out ----------------
  function renderScanOut() {
    panel.innerHTML = `
      <div class="scan-box">
        <label>Scan POS Code (item currently shown)
          <input id="scan-out-input" type="text" placeholder="Scan or type a POS code, then press Enter" autocomplete="off" />
        </label>
      </div>
      <div id="scan-out-result"></div>
    `;
    const input = panel.querySelector("#scan-out-input");
    input.focus();
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleScanOut(input.value);
        input.value = "";
      }
    });
    renderScanOutResult();
  }

  function handleScanOut(code) {
    const found = findVariantByCode(state.products, code);
    if (!found) {
      toast(`Code "${code}" not found`, "error");
      return;
    }
    state.scanOutFound = found;
    renderScanOutResult();
  }

  function renderScanOutResult() {
    const resultEl = panel.querySelector("#scan-out-result");
    if (!resultEl) return;
    if (!state.scanOutFound) {
      resultEl.innerHTML = `<p class="muted">Scan a code to see the item and what to bring out next.</p>`;
      return;
    }
    const { product, variant, variantIndex } = state.scanOutFound;
    const recommendations = getRecommendations(product, variant);

    resultEl.innerHTML = `
      ${renderItemCard(product, variant, { showMarkShown: true })}
      <h3 style="margin-top:20px;">Recommended next (same category &amp; tags, in storage)</h3>
      ${recommendations.length
        ? `<div class="rec-grid">${recommendations.map(r => renderRecCard(r)).join("")}</div>`
        : `<p class="muted">No other in-storage items match this category/tags right now.</p>`}
    `;

    const markBtn = resultEl.querySelector(".btn-mark-shown");
    if (markBtn) {
      markBtn.onclick = async () => {
        markBtn.disabled = true;
        try {
          await patchVariant(product.id, variantIndex, {
            status: "SHOWN",
            location: "Showroom",
            shown_at: new Date().toISOString(),
          });
          toast(`${product.master_code} · ${variant.size} ${variant.color_name} marked as shown`);
          state.scanOutFound = null;
          renderScanOutResult();
          panel.querySelector("#scan-out-input")?.focus();
        } catch (e) {
          toast("Failed: " + e.message, "error");
          markBtn.disabled = false;
        }
      };
    }
  }

  function getRecommendations(product, variant) {
    const out = [];
    for (const p of state.products) {
      if (p.id === product.id) continue;
      if (p.category_id !== product.category_id) continue;
      const sharesTag = (p.tag_ids || []).some(t => (product.tag_ids || []).includes(t));
      if (!sharesTag && (product.tag_ids || []).length) continue;
      (p.variants || []).forEach((v, i) => {
        if ((v.status || "STORED") === "STORED" && Number(v.stock_quantity) > 0) {
          out.push({ product: p, variant: v, variantIndex: i });
        }
      });
    }
    return out.slice(0, 12);
  }

  // ---------------- Scan In ----------------
  function renderScanIn() {
    panel.innerHTML = `
      <div class="scan-box">
        <label>Step 1 — Scan POS Code (item going back to storage)
          <input id="scan-in-code" type="text" placeholder="Scan or type a POS code, then press Enter" autocomplete="off" />
        </label>
      </div>
      <div id="scan-in-result"></div>
    `;
    const input = panel.querySelector("#scan-in-code");
    input.focus();
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleScanIn(input.value);
        input.value = "";
      }
    });
    renderScanInResult();
  }

  function handleScanIn(code) {
    const found = findVariantByCode(state.products, code);
    if (!found) {
      toast(`Code "${code}" not found`, "error");
      return;
    }
    state.scanInFound = found;
    renderScanInResult();
  }

  function renderScanInResult() {
    const resultEl = panel.querySelector("#scan-in-result");
    if (!resultEl) return;
    if (!state.scanInFound) {
      resultEl.innerHTML = `<p class="muted">Scan a code to continue.</p>`;
      return;
    }
    const { product, variant } = state.scanInFound;
    resultEl.innerHTML = `
      ${renderItemCard(product, variant, {})}
      <div class="scan-box" style="margin-top:16px;">
        <label>Step 2 — Scan or enter storage location
          <input id="scan-in-location" list="storage-locations" type="text" placeholder="e.g. A1" autocomplete="off" />
          <datalist id="storage-locations">
            ${STORAGE_LOCATIONS.map(loc => `<option value="${loc}"></option>`).join("")}
          </datalist>
        </label>
        <button id="scan-in-confirm" class="btn btn-primary">Confirm Stored</button>
      </div>
    `;
    const locInput = resultEl.querySelector("#scan-in-location");
    const confirmBtn = resultEl.querySelector("#scan-in-confirm");
    locInput.focus();
    locInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); confirmBtn.click(); } });

    confirmBtn.onclick = async () => {
      const location = locInput.value.trim();
      if (!location) {
        toast("Scan or type a location first", "error");
        return;
      }
      confirmBtn.disabled = true;
      try {
        await patchVariant(product.id, state.scanInFound.variantIndex, {
          status: "STORED",
          location,
          stored_at: new Date().toISOString(),
        });
        toast(`${product.master_code} · ${variant.size} ${variant.color_name} stored at ${location}`);
        state.scanInFound = null;
        renderScanIn();
      } catch (e) {
        toast("Failed: " + e.message, "error");
        confirmBtn.disabled = false;
      }
    };
  }

  // ---------------- Needs Rotation ----------------
  function renderRotate() {
    const items = getRotationItems();
    panel.innerHTML = `
      <p class="muted">
        ${items.length
          ? `${items.length} item${items.length === 1 ? "" : "s"} ha${items.length === 1 ? "s" : "ve"} been out on the floor ${ROTATION_DAYS}+ days — bring ${items.length === 1 ? "it" : "them"} back to storage and put something else out.`
          : `Nothing to rotate yet — everything currently shown has been out less than ${ROTATION_DAYS} days.`}
      </p>
      ${items.length ? `<div class="rec-grid">${items.map((it, i) => renderRotateCard(it, i)).join("")}</div>` : ""}
    `;
    panel.querySelectorAll(".btn-rotate-now").forEach(btn => {
      btn.onclick = () => {
        const it = items[+btn.dataset.i];
        // Hands off straight into Scan In, already filled in — staff just
        // pick where it's going and confirm, instead of re-scanning a code
        // they just looked at on this exact screen.
        state.mode = "in";
        state.scanInFound = { product: it.product, variant: it.variant, variantIndex: it.variantIndex };
        state.shellBuilt = null;
        container.querySelectorAll(".live-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === "in"));
        render();
      };
    });
  }

  function renderRotateCard(it, i) {
    const { product, variant, days } = it;
    const cover = product.images?.[0]?.url || "";
    return `
      <div class="rec-card ${days >= ROTATION_DAYS ? "rotate-due" : ""}">
        ${cover ? `<img src="${cover}" alt="" />` : `<div class="no-image">No image</div>`}
        <div class="rec-body">
          <span class="master-code">${escapeHtml(product.master_code)}</span>
          <strong>${escapeHtml(product.name)}</strong>
          <span class="muted">${escapeHtml(variant.size)} · <span class="swatch" style="background:${variant.color_hex}"></span>${escapeHtml(variant.color_name)}</span>
          <span class="badge rotate-badge">${days} day${days === 1 ? "" : "s"} out</span>
          <button class="btn btn-secondary btn-rotate-now" data-i="${i}">Rotate Now</button>
        </div>
      </div>
    `;
  }

  // ---------------- Shared item card ----------------
  function renderItemCard(product, variant, { showMarkShown } = {}) {
    const category = state.categoriesById[product.category_id];
    const tags = (product.tag_ids || []).map(id => state.tagsById[id]).filter(Boolean);
    const cover = product.images?.[0]?.url || "";
    const shownDays = variant.shown_at ? daysSince(variant.shown_at) : null;
    const statusLabel = (variant.status || "STORED") === "SHOWN"
      ? `<span class="badge" style="background:${shownDays >= ROTATION_DAYS ? "#ef4444" : "#f59e0b"};color:#fff">Shown${shownDays !== null ? ` · ${shownDays}d out` : ""}</span>`
      : `<span class="badge" style="background:#10b981;color:#fff">Stored${variant.location ? " · " + escapeHtml(variant.location) : ""}</span>`;

    return `
      <div class="scan-item-card">
        ${cover ? `<img src="${cover}" alt="" class="scan-item-img" />` : `<div class="scan-item-img no-image">No image</div>`}
        <div class="scan-item-body">
          <div class="card-top-row">
            <span class="master-code">${escapeHtml(product.master_code)}</span>
            ${category ? badge(category.name, category.color_code) : ""}
            ${statusLabel}
          </div>
          <h3 class="card-title">${escapeHtml(product.name)}</h3>
          <div class="card-tags">${tags.map(t => badge(t.name, t.color_code)).join(" ")}</div>
          <p class="muted" style="margin:4px 0;">
            ${escapeHtml(variant.size)} · <span class="swatch" style="background:${variant.color_hex}"></span>${escapeHtml(variant.color_name)}
            · POS ${escapeHtml(variant.pos_code || "—")} · Stock ${variant.stock_quantity ?? 0}
            ${variant.sample_location ? ` · Sample at ${escapeHtml(variant.sample_location)}` : ""}
          </p>
          ${showMarkShown ? `<button class="btn btn-primary btn-mark-shown">Mark as Shown</button>` : ""}
        </div>
      </div>
    `;
  }

  function renderRecCard({ product, variant }) {
    const cover = product.images?.[0]?.url || "";
    return `
      <div class="rec-card">
        ${cover ? `<img src="${cover}" alt="" />` : `<div class="no-image">No image</div>`}
        <div class="rec-body">
          <span class="master-code">${escapeHtml(product.master_code)}</span>
          <strong>${escapeHtml(product.name)}</strong>
          <span class="muted">${escapeHtml(variant.size)} · <span class="swatch" style="background:${variant.color_hex}"></span>${escapeHtml(variant.color_name)}</span>
          <span class="muted">POS ${escapeHtml(variant.pos_code || "—")} · ${escapeHtml(variant.location || "no location")} · Stock ${variant.stock_quantity ?? 0}</span>
        </div>
      </div>
    `;
  }

  // Call this when the Live tab is torn down (e.g. on logout) so its
  // Firestore listener doesn't keep running in the background.
  return () => unsubscribeProducts();
}
