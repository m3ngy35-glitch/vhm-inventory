// ============================================================================
// search.js — Global Search System.
// Client-side multi-field instant search with highlight matching.
// Works entirely on the in-memory product list (fine at boutique-catalog
// scale — hundreds to a few thousand products). Matches:
//   master_code, pos_code, alternate_codes, name, description, tag names,
//   category name.
// ============================================================================

function norm(s) {
  return (s || "").toString().toLowerCase().trim();
}

export function buildSearchIndex(products, categoriesById, tagsById) {
  return products.map(p => {
    const posCodes = (p.variants || []).flatMap(v => [v.pos_code, ...(v.alternate_codes || [])]).filter(Boolean);
    const tagNames = (p.tag_ids || []).map(id => tagsById[id]?.name).filter(Boolean);
    const categoryName = categoriesById[p.category_id]?.name || "";
    const haystack = norm([
      p.master_code, p.name, p.description, categoryName, ...tagNames, ...posCodes,
    ].join(" | "));
    return { product: p, haystack, posCodes, tagNames, categoryName };
  });
}

export function searchProducts(index, rawQuery, { categoryId, tagId, size } = {}) {
  const q = norm(rawQuery);
  const terms = q.split(/\s+/).filter(Boolean);

  return index.filter(entry => {
    const p = entry.product;
    if (categoryId && p.category_id !== categoryId) return false;
    if (tagId && !(p.tag_ids || []).includes(tagId)) return false;
    if (size && !(p.variants || []).some(v => v.size === size)) return false;
    if (terms.length === 0) return true;
    return terms.every(t => entry.haystack.includes(t));
  }).map(e => e.product);
}

// Wraps matches of `query` in <mark> for highlight-as-you-type display.
export function highlight(text, rawQuery) {
  if (!text) return "";
  const q = norm(rawQuery);
  if (!q) return escapeHtml(text);
  const terms = q.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  let result = escapeHtml(text);
  for (const term of terms) {
    const re = new RegExp(`(${escapeRegExp(escapeHtml(term))})`, "ig");
    result = result.replace(re, "<mark>$1</mark>");
  }
  return result;
}

// Exact code lookup for barcode/POS scanning (Live tab): finds the single
// product+variant whose pos_code or an alternate_code matches, ignoring
// case/whitespace (scanners sometimes add these inconsistently).
export function findVariantByCode(products, rawCode) {
  const code = norm(rawCode);
  if (!code) return null;
  for (const product of products) {
    const variants = product.variants || [];
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const codes = [v.pos_code, ...(v.alternate_codes || [])].map(norm);
      if (codes.includes(code)) {
        return { product, variant: v, variantIndex: i };
      }
    }
  }
  return null;
}

function escapeHtml(s) {
  return (s || "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
