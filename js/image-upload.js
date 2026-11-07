// ============================================================================
// image-upload.js — Image Uploader component.
// Drag-and-drop, preview thumbnails, reorder by dragging, remove.
// Uploads happen on save (uploadPendingImages), not on drop, so a user can
// still reorder/remove before committing.
// ============================================================================

import { uploadProductImage } from "./db.js";
import { toast } from "./ui-components.js";

// Keep product photos sharp enough for the full-screen gallery without storing
// multi-megabyte phone-camera originals. The 1.5 MB target leaves headroom
// under the 2 MB Storage rule in case of metadata/encoding differences.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const TARGET_BYTES = Math.floor(1.5 * 1024 * 1024);
const MAX_EDGE = 1600;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 1024 * 1024 ? 1 : 2)} MB`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This photo could not be opened.")); };
    img.src = url;
  });
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("This photo could not be prepared.")), type, quality);
  });
}

async function prepareImage(file) {
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error(`${file.name}: use JPG, PNG or WebP.`);
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`${file.name}: the original is over 25 MB.`);
  }

  const img = await loadImage(file);
  if (!img.naturalWidth || !img.naturalHeight) throw new Error(`${file.name}: invalid photo.`);

  // Already-efficient photos keep their original bytes, avoiding needless
  // quality loss when staff upload an image that has already been optimized.
  if (Math.max(img.naturalWidth, img.naturalHeight) <= MAX_EDGE && file.size <= TARGET_BYTES) {
    return file;
  }

  const attempts = [
    [1600, 0.84], [1600, 0.74], [1400, 0.72],
    [1200, 0.70], [1000, 0.68], [800, 0.66],
  ];
  let blob = null;
  for (const [edge, quality] of attempts) {
    const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error(`${file.name}: this browser cannot resize photos.`);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    blob = await canvasBlob(canvas, "image/webp", quality);
    if (blob.size <= TARGET_BYTES) break;
  }
  if (!blob || blob.size > TARGET_BYTES) {
    throw new Error(`${file.name}: could not reduce it below 1.5 MB.`);
  }

  const base = file.name.replace(/\.[^.]+$/, "") || "product-photo";
  return new File([blob], `${base}.webp`, { type: "image/webp", lastModified: file.lastModified });
}

export function createImageUploader(container, initialImages = []) {
  // state items: { url, path, order, name, file? (pending upload), isNew? }
  let items = initialImages.map((img, i) => ({ ...img, order: i }));
  let dragFromIdx = null;
  let isPreparing = false;
  let prepareStatus = "";
  let preparationPromise = Promise.resolve();
  let disposed = false;

  function render() {
    container.innerHTML = `
      <div class="uploader-drop" id="uploader-drop">
        <strong>${isPreparing ? "Preparing photos…" : "Drop photos here or click to choose"}</strong>
        <span class="uploader-note">JPG, PNG or WebP · max 1600 px · about 1.5 MB each</span>
        ${prepareStatus ? `<span class="uploader-status">${prepareStatus}</span>` : ""}
        <input type="file" id="uploader-input" accept="image/jpeg,image/png,image/webp" multiple hidden />
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
    drop.onclick = () => { if (!isPreparing) input.click(); };
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("drag-over"); };
    drop.ondragleave = () => drop.classList.remove("drag-over");
    drop.ondrop = e => {
      e.preventDefault();
      drop.classList.remove("drag-over");
      if (!isPreparing) preparationPromise = addFiles(e.dataTransfer.files);
    };
    input.onchange = () => {
      preparationPromise = addFiles(input.files);
      input.value = "";
    };

    container.querySelectorAll(".thumb-remove").forEach(btn => {
      btn.onclick = () => {
        const [removed] = items.splice(+btn.dataset.idx, 1);
        // Blob preview URLs aren't freed just because nothing references
        // them anymore — the browser keeps that memory until the page
        // closes or this is called explicitly. With the form opened many
        // times a day, that adds up.
        if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
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

  async function addFiles(fileList) {
    if (isPreparing) return;
    const files = [...fileList];
    if (!files.length) return;
    isPreparing = true;
    prepareStatus = `0 of ${files.length}`;
    render();
    let added = 0;
    for (let i = 0; i < files.length; i++) {
      try {
        const original = files[i];
        const file = await prepareImage(original);
        if (disposed) return;
        items.push({
          file,
          previewUrl: URL.createObjectURL(file),
          name: file.name,
          order: items.length,
          isNew: true,
        });
        added++;
        if (file !== original) {
          console.info(`Prepared ${original.name}: ${formatMb(original.size)} → ${formatMb(file.size)}`);
        }
      } catch (e) {
        toast(e.message || "A photo could not be prepared.", "error");
      }
      prepareStatus = `${i + 1} of ${files.length}`;
      if (!disposed) render();
    }
    isPreparing = false;
    prepareStatus = added ? `${added} photo${added === 1 ? "" : "s"} ready` : "No photos added";
    if (!disposed) render();
  }

  render();

  return {
    getItems: () => items,
    waitUntilReady: () => preparationPromise,
    // Call when the form closes (cancelled or saved) to release any
    // preview blob URLs still held for images that were never uploaded
    // (e.g. the user picked files, then cancelled without saving).
    cleanup: () => {
      disposed = true;
      items.forEach(it => { if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); });
    },
    // Uploads any pending (isNew) files to Storage. Returns { images,
    // failedNames } instead of throwing or just returning the array —
    // the caller (product-form.js) needs to know when some photos
    // didn't make it so it can tell the user clearly, rather than
    // showing the same "Product saved" message it would for a fully
    // successful save. A failed upload here previously only got a
    // toast that auto-dismissed in ~2.6s — easy to miss, and the save
    // still reported success right after, which is actively misleading.
    async uploadPendingImages(productId) {
      const failedNames = [];
      for (const it of items) {
        if (it.isNew && it.file) {
          try {
            const uploaded = await uploadProductImage(productId, it.file, it.order);
            // Mutate the item in place (rather than building a separate
            // results array) so that if the user saves again after a
            // partial failure, this succeeded photo isn't re-uploaded —
            // only whatever is still marked isNew gets retried.
            if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
            Object.assign(it, uploaded, { isNew: false, file: undefined, previewUrl: undefined });
          } catch (e) {
            failedNames.push(it.name);
          }
        }
      }
      const images = items
        .filter(it => !(it.isNew && it.file)) // drop whatever is still pending (failed) — don't save a broken reference
        .map((it, i) => {
          const { previewUrl, file, isNew, ...clean } = it;
          return { ...clean, order: i };
        });
      return { images, failedNames };
    },
  };
}
