// ============================================================================
// app.js — main entry point. Wires together search, product grid,
// inline variant editing, and the modals (product form, category/tag manager).
// ============================================================================

import { subscribeProducts, listCategories, listTags, archiveProduct, restoreProduct, patchVariant, exportAllData } from "./db.js";
import { buildSearchIndex, searchProducts, highlight } from "./search.js";
import { badge, toast, openGallery, escapeHtml, confirmDialog } from "./ui-components.js";
import { SIZES, STORAGE_LOCATIONS } from "./constants.js";
import { openProductForm } from "./product-form.js";
import { openCategoryTagManager } from "./category-tag-manager.js";
import { watchAuth, login, logout } from "./auth.js";
import { initLiveTab } from "./live-tab.js";

const state = {
  products: [],
  allProducts: [], // includes soft-deleted, for the Recently Deleted view
  categories: [],
  tags: [],
  categoriesById: {},
  tagsById: {},
  searchIndex: [],
  query: "",
  filters: { categoryId: "", tagId: "", size: "" },
};

const els = {
  grid: document.getElementById("product-grid"),
  searchInput: document.getElementById("search-input"),
  categoryFilter: document.getElementById("filter-category"),
  tagFilter: document.getElementById("filter-tag"),
  sizeFilter: document.getElementById("filter-size"),
  resultCount: document.getElementById("result-count"),
  newProductBtn: document.getElementById("btn-new-product"),
  manageBtn: document.getElementById("btn-manage-cattags"),
  categoryPills: document.getElementById("category-pills"),
  filtersBtn: document.getElementById("btn-filters"),
  filtersPanel: document.getElementById("filters-panel"),
  filtersBackdrop: document.getElementById("filters-backdrop"),
  filtersCloseBtn: document.getElementById("btn-filters-close"),
  filtersApplyBtn: document.getElementById("btn-filters-apply"),
};

async function loadMeta() {
  const [categories, tags] = await Promise.all([listCategories(), listTags()]);
  state.categories = categories;
  state.tags = tags;
  state.categoriesById = Object.fromEntries(categories.map(c => [c.id, c]));
  state.tagsById = Object.fromEntries(tags.map(t => [t.id, t]));

  els.categoryFilter.innerHTML = `<option value="">All categories</option>` +
    categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  els.tagFilter.innerHTML = `<option value="">All tags</option>` +
    tags.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  els.sizeFilter.innerHTML = `<option value="">All sizes</option>` +
    SIZES.map(s => `<option value="${s}">${s}</option>`).join("");

  // Mobile-only quick-filter strip — the same categoryId state the
  // dropdown in the filters drawer controls, just as one-tap pills for
  // the filter people reach for most often, instead of opening the
  // drawer for it every time.
  if (els.categoryPills) {
    els.categoryPills.innerHTML = `<button type="button" class="pill-btn active" data-id="">All</button>` +
      categories.map(c => `<button type="button" class="pill-btn" data-id="${c.id}">${escapeHtml(c.name)}</button>`).join("");
  }

  const locList = document.getElementById("storage-locations-quickedit");
  if (locList && !locList.childElementCount) {
    locList.innerHTML = STORAGE_LOCATIONS.map(loc => `<option value="${loc}"></option>`).join("");
  }
}

function rebuildIndex() {
  state.searchIndex = buildSearchIndex(state.products, state.categoriesById, state.tagsById);
}

function renderGrid() {
  const results = searchProducts(state.searchIndex, state.query, {
    categoryId: state.filters.categoryId || null,
    tagId: state.filters.tagId || null,
    size: state.filters.size || null,
  });
  els.resultCount.textContent = `${results.length} product${results.length === 1 ? "" : "s"}`;

  if (!results.length) {
    els.grid.innerHTML = `<p class="muted">No products match your search.</p>`;
    return;
  }

  els.grid.innerHTML = results.map(p => renderProductCard(p)).join("");
  wireCardEvents(results);
}

function renderProductCard(p) {
  const category = state.categoriesById[p.category_id];
  const tags = (p.tag_ids || []).map(id => state.tagsById[id]).filter(Boolean);
  const cover = p.images?.[0]?.url || "";
  const totalStock = (p.variants || []).reduce((sum, v) => sum + (Number(v.stock_quantity) || 0), 0);
  const lowStock = totalStock === 0;
  // Multiple variants can sit in the same bin, or in different ones — show
  // each distinct location once, as its own chip, the same way tags show
  // as one chip each rather than one per variant.
  const storageLocations = [...new Set((p.variants || []).map(v => v.location).filter(Boolean))];
  const sampleLocations = [...new Set((p.variants || []).map(v => v.sample_location).filter(Boolean))];

  return `
    <div class="product-card" data-id="${p.id}">
      <div class="card-image" data-id="${p.id}">
        ${cover ? `<img src="${cover}" alt="${escapeHtml(p.name)}" />` : `<div class="no-image">No image</div>`}
        ${p.images?.length > 1 ? `<span class="image-count">${p.images.length} photos</span>` : ""}
      </div>
      <div class="card-locations">
        <span class="loc-chip loc-chip-storage">Storage: ${storageLocations.length ? escapeHtml(storageLocations.join(", ")) : "—"}</span>
        <span class="loc-chip loc-chip-sample">Sample: ${sampleLocations.length ? escapeHtml(sampleLocations.join(", ")) : "—"}</span>
      </div>
      <div class="card-body">
        <div class="card-top-row">
          <span class="master-code">${highlight(p.master_code, state.query)}</span>
          ${category ? badge(category.name, category.color_code) : ""}
        </div>
        <h3 class="card-title">${highlight(p.name, state.query)}</h3>
        <div class="card-tags">${tags.map(t => badge(t.name, t.color_code)).join(" ")}</div>
        ${p.description ? `<p class="card-description muted">${escapeHtml(p.description)}</p>` : ""}
        <div class="card-stock ${lowStock ? "stock-zero" : ""}">Total stock: ${totalStock}</div>
        <details class="variant-inline">
          <summary>${(p.variants || []).length} variant${(p.variants || []).length === 1 ? "" : "s"} — quick edit</summary>
          <table class="variant-inline-table">
            <thead><tr><th>Size</th><th>Color</th><th>POS</th><th>Stock</th><th>Price</th><th>Storage</th><th>Sample</th></tr></thead>
            <tbody>
              ${(p.variants || []).map((v, i) => `
                <tr>
                  <td data-label="Size">${v.size}</td>
                  <td data-label="Color"><span class="swatch" style="background:${v.color_hex}"></span>${escapeHtml(v.color_name)}</td>
                  <td data-label="POS"><input class="inline-pos" data-pid="${p.id}" data-idx="${i}" value="${escapeHtml(v.pos_code)}" /></td>
                  <td data-label="Stock"><input class="inline-stock" type="number" min="0" data-pid="${p.id}" data-idx="${i}" value="${v.stock_quantity}" /></td>
                  <td data-label="Price"><input class="inline-price" type="number" min="0" step="0.01" data-pid="${p.id}" data-idx="${i}" value="${v.price ?? 0}" /></td>
                  <td data-label="Storage"><input class="inline-location loc-pill loc-storage" list="storage-locations-quickedit" data-pid="${p.id}" data-idx="${i}" value="${escapeHtml(v.location)}" placeholder="A1" title="Primary storage (actual stock)" /></td>
                  <td data-label="Sample"><input class="inline-location loc-pill loc-sample" data-pid="${p.id}" data-idx="${i}" value="${escapeHtml(v.sample_location)}" placeholder="e.g. Front window" title="Sample/display piece only" /></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </details>
        <div class="card-actions">
          <button class="btn btn-secondary btn-edit" data-id="${p.id}">Edit</button>
          <button class="btn btn-danger btn-delete" data-id="${p.id}">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function wireCardEvents(results) {
  const byId = Object.fromEntries(results.map(p => [p.id, p]));

  document.querySelectorAll(".card-image").forEach(el => {
    el.onclick = () => {
      const p = byId[el.dataset.id];
      if (p.images?.length) openGallery(p.images, 0);
    };
  });

  document.querySelectorAll(".btn-edit").forEach(btn => {
    btn.onclick = () => {
      openProductForm({
        product: byId[btn.dataset.id],
        categories: state.categories,
        tags: state.tags,
        onSaved: () => {}, // live subscription re-renders automatically
      });
    };
  });

  document.querySelectorAll(".btn-delete").forEach(btn => {
    btn.onclick = async () => {
      const ok = await confirmDialog("Remove this product? You can restore it later from \"Recently Deleted\".");
      if (!ok) return;
      btn.disabled = true;
      try {
        await archiveProduct(btn.dataset.id);
        toast("Product removed — recoverable from Recently Deleted");
      } catch (e) {
        toast("Delete failed: " + e.message, "error");
        btn.disabled = false;
      }
    };
  });

  // Inline quick-edit: POS code, stock, price, and both locations,
  // debounced-ish on blur/enter.
  document.querySelectorAll(".inline-pos, .inline-stock, .inline-price, .inline-location").forEach(input => {
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
    input.addEventListener("blur", async () => {
      const pid = input.dataset.pid, idx = +input.dataset.idx;
      let patch;
      if (input.classList.contains("inline-stock")) patch = { stock_quantity: Number(input.value) || 0 };
      else if (input.classList.contains("inline-price")) patch = { price: Number(input.value) || 0 };
      else if (input.classList.contains("loc-storage")) patch = { location: input.value.trim() };
      else if (input.classList.contains("loc-sample")) patch = { sample_location: input.value.trim() };
      else patch = { pos_code: input.value.trim() };
      try {
        await patchVariant(pid, idx, patch);
        toast("Variant updated");
      } catch (e) {
        toast("Update failed: " + e.message, "error");
      }
    });
  });
}

function wireToolbar() {
  els.searchInput.addEventListener("input", () => {
    state.query = els.searchInput.value;
    renderGrid();
  });
  els.categoryFilter.addEventListener("change", () => {
    state.filters.categoryId = els.categoryFilter.value;
    syncCategoryPills();
    renderGrid();
  });
  els.tagFilter.addEventListener("change", () => {
    state.filters.tagId = els.tagFilter.value;
    renderGrid();
  });
  els.sizeFilter.addEventListener("change", () => {
    state.filters.size = els.sizeFilter.value;
    renderGrid();
  });
  els.newProductBtn.onclick = () => {
    openProductForm({ product: null, categories: state.categories, tags: state.tags, onSaved: () => {} });
  };
  els.manageBtn.onclick = () => {
    openCategoryTagManager({ onChanged: async () => { await loadMeta(); rebuildIndex(); renderGrid(); } });
  };
  document.getElementById("btn-deleted").onclick = openRecentlyDeleted;
  document.getElementById("btn-backup").onclick = downloadBackup;

  // Category quick-filter pills (mobile) — same state.filters.categoryId
  // the dropdown drives, kept in sync both directions so opening the
  // drawer after tapping a pill (or vice versa) never shows a stale value.
  els.categoryPills?.addEventListener("click", e => {
    const btn = e.target.closest(".pill-btn");
    if (!btn) return;
    state.filters.categoryId = btn.dataset.id;
    els.categoryFilter.value = btn.dataset.id;
    syncCategoryPills();
    renderGrid();
  });

  // Filters drawer (mobile) — open/close only; the selects inside already
  // filter live via the handlers above, so "Apply" just dismisses the sheet.
  const openFilters = () => { els.filtersPanel.classList.add("open"); els.filtersBackdrop.hidden = false; };
  const closeFilters = () => { els.filtersPanel.classList.remove("open"); els.filtersBackdrop.hidden = true; };
  els.filtersBtn?.addEventListener("click", openFilters);
  els.filtersCloseBtn?.addEventListener("click", closeFilters);
  els.filtersApplyBtn?.addEventListener("click", closeFilters);
  els.filtersBackdrop?.addEventListener("click", closeFilters);

  wireNav();
}

function syncCategoryPills() {
  els.categoryPills?.querySelectorAll(".pill-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.id === state.filters.categoryId);
  });
}

function openRecentlyDeleted() {
  const deleted = state.allProducts.filter(p => p.deleted);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Recently Deleted</h2>
        <button class="btn-icon modal-close">&times;</button>
      </div>
      <div class="modal-body">
        ${deleted.length
          ? deleted.map(p => `
              <div class="chip-row" data-id="${p.id}" style="justify-content:space-between; width:100%;">
                <span>${escapeHtml(p.master_code)} — ${escapeHtml(p.name)}</span>
                <button class="btn btn-secondary btn-restore" data-id="${p.id}">Restore</button>
              </div>
            `).join("")
          : `<p class="muted">Nothing here — deleted products show up so you can bring them back.</p>`}
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary modal-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelectorAll(".modal-close").forEach(btn => btn.onclick = () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelectorAll(".btn-restore").forEach(btn => {
    btn.onclick = async () => {
      await restoreProduct(btn.dataset.id);
      toast("Product restored");
      overlay.remove();
    };
  });
}

async function downloadBackup() {
  try {
    const data = await exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vhm-inventory-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Backup downloaded");
  } catch (e) {
    toast("Backup failed: " + e.message, "error");
  }
}

let liveTabInitialized = false;
let unsubscribeLiveTab = null;
function wireNav() {
  const navProducts = document.getElementById("nav-products");
  const navLive = document.getElementById("nav-live");
  const productsView = document.getElementById("products-view");
  const liveView = document.getElementById("live-view");
  const toolbar = document.getElementById("products-toolbar");
  const toolbarActions = document.getElementById("products-toolbar-actions");

  navProducts.onclick = () => {
    navProducts.classList.add("active");
    navLive.classList.remove("active");
    productsView.hidden = false;
    liveView.hidden = true;
    toolbar.hidden = false;
    toolbarActions.hidden = false;
  };

  navLive.onclick = () => {
    navLive.classList.add("active");
    navProducts.classList.remove("active");
    productsView.hidden = true;
    liveView.hidden = false;
    toolbar.hidden = true;
    toolbarActions.hidden = true;
    if (!liveTabInitialized) {
      liveTabInitialized = true;
      unsubscribeLiveTab = initLiveTab(liveView);
    }
  };
}

let unsubscribeProducts = null;

async function startApp() {
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app-shell").hidden = false;
  try {
    await loadMeta();
    wireToolbar();
    document.getElementById("btn-logout").onclick = async () => {
      unsubscribeProducts?.();
      await logout();
    };
    unsubscribeProducts = subscribeProducts(products => {
      state.allProducts = products;
      state.products = products.filter(p => !p.deleted);
      rebuildIndex();
      renderGrid();
    });
  } catch (err) {
    console.error(err);
    toast("Failed to load data — check Firestore rules & that Auth is enabled", "error");
  }
}

function showLogin() {
  unsubscribeProducts?.();
  // Otherwise the Live tab's own Firestore listener keeps running in the
  // background after logout, and — since liveTabInitialized would stay
  // true — never gets set up again on the next login either.
  unsubscribeLiveTab?.();
  unsubscribeLiveTab = null;
  liveTabInitialized = false;
  document.getElementById("app-shell").hidden = true;
  const loginScreen = document.getElementById("login-screen");
  loginScreen.hidden = false;

  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");
  form.onsubmit = async e => {
    e.preventDefault();
    errorEl.hidden = true;
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const submitBtn = document.getElementById("login-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";
    try {
      await login(email, password);
      // onAuthStateChanged (below) picks up the change and calls startApp()
    } catch (err) {
      errorEl.textContent = friendlyAuthError(err);
      errorEl.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign In";
    }
  };
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Wrong email or password.";
  }
  if (code.includes("too-many-requests")) {
    return "Too many attempts — wait a moment and try again.";
  }
  if (code.includes("invalid-email")) {
    return "That doesn't look like a valid email.";
  }
  return "Sign-in failed: " + (err?.message || "unknown error");
}

watchAuth(user => {
  if (user) startApp();
  else showLogin();
});
