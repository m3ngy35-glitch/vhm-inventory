// ============================================================================
// ui-components.js — small reusable UI pieces: color badges, toasts,
// the image gallery viewer. Pure DOM/string helpers, no Firebase here.
// ============================================================================

export function badge(name, colorHex) {
  const fg = readableTextColor(colorHex);
  return `<span class="badge" style="background:${colorHex};color:${fg}">${escapeHtml(name)}</span>`;
}

export function readableTextColor(hex) {
  if (!hex) return "#fff";
  const c = hex.replace("#", "");
  if (c.length !== 6) return "#fff";
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111" : "#fff";
}

let toastTimer;
export function toast(message, type = "info") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.className = `toast toast-${type} show`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

export function openGallery(images, startIndex = 0) {
  const overlay = document.createElement("div");
  overlay.className = "gallery-overlay";
  let idx = startIndex;
  render();
  document.body.appendChild(overlay);

  function render() {
    const img = images[idx];
    overlay.innerHTML = `
      <div class="gallery-close" title="Close">&times;</div>
      <div class="gallery-nav gallery-prev">&#8249;</div>
      <img class="gallery-img" src="${img?.url || ""}" alt="" />
      <div class="gallery-nav gallery-next">&#8250;</div>
      <div class="gallery-count">${idx + 1} / ${images.length}</div>
    `;
    overlay.querySelector(".gallery-close").onclick = () => overlay.remove();
    overlay.querySelector(".gallery-prev").onclick = () => { idx = (idx - 1 + images.length) % images.length; render(); };
    overlay.querySelector(".gallery-next").onclick = () => { idx = (idx + 1) % images.length; render(); };
  }
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

export function escapeHtml(s) {
  return (s || "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
