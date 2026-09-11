// ============================================================================
// image-upload.js — Image Uploader component.
// Drag-and-drop, preview thumbnails, reorder by dragging, remove.
// Uploads happen on save (uploadPendingImages), not on drop, so a user can
// still reorder/remove before committing.
// ============================================================================

import { uploadProductImage } from "./db.js";
import { toast } from "./ui-components.js";

export function createImageUploader(container, initialImages = []) {
  // state items: { url, path, order, name, file? (pending upload), isNew? }
  let items = initialImages.map((img, i) => ({ ...img, order: i }));
  let dragFromIdx = null;

  function render() {
    container.innerHTML = `
      <div class="uploader-drop" id="uploader-drop">
        Drag & drop images here, or click to choose files
        <input type="file" id="uploader-input" accept="image/*" multiple hidden />
      </div>
      <div class="uploader-grid">
        ${items.map((it, i) => `
          <div class="uploader-thumb" draggable="true" data-idx="${i}">
            <img src="${it.previewUrl || it.url}" alt="" />
            <button class="thumb-remove" data-idx="${i}" title="Remove">&times;</button>
            <span class="thumb-order">${i + 1}</span>
          </div>
        `).join("")}
      </div>
    `;
    wireEvents();
  }

  function wireEvents() {
    const drop = container.querySelector("#uploader-drop");
    const input = container.querySelector("#uploader-input");
    drop.onclick = () => input.click();
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("drag-over"); };
    drop.ondragleave = () => drop.classList.remove("drag-over");
    drop.ondrop = e => {
      e.preventDefault();
      drop.classList.remove("drag-over");
      addFiles(e.dataTransfer.files);
    };
    input.onchange = () => addFiles(input.files);

    container.querySelectorAll(".thumb-remove").forEach(btn => {
      btn.onclick = () => {
        items.splice(+btn.dataset.idx, 1);
        items = items.map((it, i) => ({ ...it, order: i }));
        render();
      };
    });

    container.querySelectorAll(".uploader-thumb").forEach(el => {
      el.ondragstart = () => { dragFromIdx = +el.dataset.idx; };
      el.ondragover = e => e.preventDefault();
      el.ondrop = e => {
        e.preventDefault();
        const toIdx = +el.dataset.idx;
        if (dragFromIdx === null || dragFromIdx === toIdx) return;
        const [moved] = items.splice(dragFromIdx, 1);
        items.splice(toIdx, 0, moved);
        items = items.map((it, i) => ({ ...it, order: i }));
        render();
      };
    });
  }

  function addFiles(fileList) {
    for (const file of fileList) {
      if (!file.type.startsWith("image/")) continue;
      items.push({
        file,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
        order: items.length,
        isNew: true,
      });
    }
    render();
  }

  render();

  return {
    getItems: () => items,
    // Uploads any pending (isNew) files to Storage, returns the final
    // images array ready to save on the product document.
    async uploadPendingImages(productId) {
      const results = [];
      for (const it of items) {
        if (it.isNew && it.file) {
          try {
            const uploaded = await uploadProductImage(productId, it.file, it.order);
            results.push(uploaded);
          } catch (e) {
            toast(`Image upload failed: ${it.name}`, "error");
          }
        } else {
          const { previewUrl, file, isNew, ...clean } = it;
          results.push(clean);
        }
      }
      return results.map((img, i) => ({ ...img, order: i }));
    },
  };
}
