// ============================================================================
// category-tag-manager.js — manage Categories and Tags (name + color badge).
// ============================================================================

import { listCategories, saveCategory, deleteCategory, listTags, saveTag, deleteTag } from "./db.js";
import { badge, toast } from "./ui-components.js";
import { DEFAULT_CATEGORY_COLOR, DEFAULT_TAG_COLOR } from "./constants.js";

export function openCategoryTagManager({ onChanged }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Categories & Tags</h2>
        <button class="btn-icon modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <h3>Categories</h3>
        <div id="cat-list" class="chip-manager-list"></div>
        <div class="form-row">
          <input id="cat-name" type="text" placeholder="New category name" />
          <input id="cat-color" type="color" value="${DEFAULT_CATEGORY_COLOR}" />
          <button id="cat-add" class="btn btn-secondary">Add</button>
        </div>
        <hr/>
        <h3>Tags</h3>
        <div id="tag-list" class="chip-manager-list"></div>
        <div class="form-row">
          <input id="tag-name" type="text" placeholder="New tag name" />
          <input id="tag-color" type="color" value="${DEFAULT_TAG_COLOR}" />
          <button id="tag-add" class="btn btn-secondary">Add</button>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary modal-close">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelectorAll(".modal-close").forEach(btn => btn.onclick = () => { overlay.remove(); onChanged?.(); });
  overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); onChanged?.(); } });

  // Tracks the names currently in Firestore so "Add" can warn on a
  // near-duplicate instead of silently creating a second copy — refreshed
  // every time refreshAll() runs.
  let existingCatNames = [];
  let existingTagNames = [];

  async function renderCategories() {
    const cats = await listCategories();
    existingCatNames = cats.map(c => (c.name || "").toLowerCase());
    overlay.querySelector("#cat-list").innerHTML = cats.map(c => `
      <div class="chip-row" data-id="${c.id}">
        ${badge(c.name, c.color_code)}
        <button class="btn-icon chip-delete" data-id="${c.id}" data-kind="cat" title="Delete">&times;</button>
      </div>
    `).join("") || `<p class="muted">No categories yet.</p>`;
    wireDeletes();
  }
  async function renderTags() {
    const tags = await listTags();
    existingTagNames = tags.map(t => (t.name || "").toLowerCase());
    overlay.querySelector("#tag-list").innerHTML = tags.map(t => `
      <div class="chip-row" data-id="${t.id}">
        ${badge(t.name, t.color_code)}
        <button class="btn-icon chip-delete" data-id="${t.id}" data-kind="tag" title="Delete">&times;</button>
      </div>
    `).join("") || `<p class="muted">No tags yet.</p>`;
    wireDeletes();
  }
  function wireDeletes() {
    overlay.querySelectorAll(".chip-delete").forEach(btn => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          if (btn.dataset.kind === "cat") await deleteCategory(btn.dataset.id);
          else await deleteTag(btn.dataset.id);
          await refreshAll();
        } catch (e) {
          toast("Delete failed: " + e.message, "error");
          btn.disabled = false;
        }
      };
    });
  }
  async function refreshAll() {
    try {
      await renderCategories();
      await renderTags();
    } catch (e) {
      toast("Failed to load categories/tags: " + e.message, "error");
    }
  }

  overlay.querySelector("#cat-add").onclick = async () => {
    const btn = overlay.querySelector("#cat-add");
    const nameInput = overlay.querySelector("#cat-name");
    const name = nameInput.value.trim();
    const color_code = overlay.querySelector("#cat-color").value;
    if (!name) return toast("Enter a category name", "error");
    if (existingCatNames.includes(name.toLowerCase())) {
      return toast(`"${name}" already exists`, "error");
    }
    // Disabling for the round-trip is what actually stops a double-tap (or
    // a slow/flaky connection, like a POS machine's) from creating the
    // same category twice before the first request has even finished.
    btn.disabled = true;
    try {
      await saveCategory({ name, color_code });
      nameInput.value = "";
      await refreshAll();
      toast("Category added");
    } catch (e) {
      toast("Failed to add category: " + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  };
  overlay.querySelector("#tag-add").onclick = async () => {
    const btn = overlay.querySelector("#tag-add");
    const nameInput = overlay.querySelector("#tag-name");
    const name = nameInput.value.trim();
    const color_code = overlay.querySelector("#tag-color").value;
    if (!name) return toast("Enter a tag name", "error");
    if (existingTagNames.includes(name.toLowerCase())) {
      return toast(`"${name}" already exists`, "error");
    }
    btn.disabled = true;
    try {
      await saveTag({ name, color_code });
      nameInput.value = "";
      await refreshAll();
      toast("Tag added");
    } catch (e) {
      toast("Failed to add tag: " + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  };

  refreshAll();
}
