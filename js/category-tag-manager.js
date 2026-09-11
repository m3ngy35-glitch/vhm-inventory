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

  async function renderCategories() {
    const cats = await listCategories();
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
        if (btn.dataset.kind === "cat") await deleteCategory(btn.dataset.id);
        else await deleteTag(btn.dataset.id);
        await refreshAll();
      };
    });
  }
  async function refreshAll() {
    await renderCategories();
    await renderTags();
  }

  overlay.querySelector("#cat-add").onclick = async () => {
    const name = overlay.querySelector("#cat-name").value.trim();
    const color_code = overlay.querySelector("#cat-color").value;
    if (!name) return toast("Enter a category name", "error");
    await saveCategory({ name, color_code });
    overlay.querySelector("#cat-name").value = "";
    await refreshAll();
    toast("Category added");
  };
  overlay.querySelector("#tag-add").onclick = async () => {
    const name = overlay.querySelector("#tag-name").value.trim();
    const color_code = overlay.querySelector("#tag-color").value;
    if (!name) return toast("Enter a tag name", "error");
    await saveTag({ name, color_code });
    overlay.querySelector("#tag-name").value = "";
    await refreshAll();
    toast("Tag added");
  };

  refreshAll();
}
