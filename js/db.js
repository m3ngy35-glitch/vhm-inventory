// ============================================================================
// db.js — the ONLY file that talks to Firebase directly.
// Every other file goes through the functions exported here. This is the
// "decoupled" boundary: swap Firestore for something else later and only
// this file needs to change.
// ============================================================================

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDocs, getDoc, addDoc, setDoc,
  updateDoc, deleteDoc, query, orderBy, onSnapshot, writeBatch, serverTimestamp,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";
import { auth } from "./auth.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const dbFs = getFirestore(app);
export const storage = getStorage(app);

function currentUserEmail() {
  return auth.currentUser?.email || null;
}

// ---------- Categories ----------
export async function listCategories() {
  const snap = await getDocs(query(collection(dbFs, "categories"), orderBy("name")));
  // ...d.data() spread FIRST, id: d.id LAST — the real Firestore document
  // id must always win over anything named "id" that ended up stored
  // inside the document's own data (see the saveProduct comment below for
  // exactly how that happens and why it's dangerous if id: d.id comes first).
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}
export async function saveCategory(cat) {
  if (cat.id) {
    const { id, ...rest } = cat;
    await updateDoc(doc(dbFs, "categories", id), rest);
    return id;
  }
  const { id, ...rest } = cat; // strip any stray id before creating — see saveProduct
  const ref_ = await addDoc(collection(dbFs, "categories"), rest);
  return ref_.id;
}
export async function deleteCategory(id) {
  await deleteDoc(doc(dbFs, "categories", id));
}

// ---------- Tags ----------
export async function listTags() {
  const snap = await getDocs(query(collection(dbFs, "tags"), orderBy("name")));
  return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}
export async function saveTag(tag) {
  if (tag.id) {
    const { id, ...rest } = tag;
    await updateDoc(doc(dbFs, "tags", id), rest);
    return id;
  }
  const { id, ...rest } = tag; // strip any stray id before creating — see saveProduct
  const ref_ = await addDoc(collection(dbFs, "tags"), rest);
  return ref_.id;
}
export async function deleteTag(id) {
  await deleteDoc(doc(dbFs, "tags", id));
}

// ---------- Products (with embedded variants array — simplest reliable
// model for Firestore at boutique scale; avoids the "shared-blob" bug
// pattern from earlier tools since each product is its own document) ----
// { serverTimestamps: "estimate" } matters here: right after this device
// creates or edits a product, its own write shows up locally as "pending"
// before the server confirms it, and by default Firestore reports a
// pending serverTimestamp() field as null. Since the query below is
// ordered BY that same field (updated_at), a null value can sort the
// brand-new/just-edited product out of where it belongs (it can briefly
// look like it didn't get added, especially on a slow connection) until
// the server round-trip finishes. "estimate" uses this device's clock as
// a placeholder immediately, so it sorts correctly from the first frame
// and simply gets nudged to the exact right spot once the server confirms.
const TIMESTAMP_OPTS = { serverTimestamps: "estimate" };

export async function listProducts() {
  const snap = await getDocs(query(collection(dbFs, "products"), orderBy("updated_at", "desc")));
  // ...d.data() FIRST, id: d.id LAST — see the note in saveProduct about
  // why a stored "id" field inside the document must never win over the
  // real Firestore document id.
  return snap.docs.map(d => ({ ...d.data(TIMESTAMP_OPTS), id: d.id }));
}

export function subscribeProducts(callback) {
  // live updates — multiple staff editing at once stay in sync
  const q = query(collection(dbFs, "products"), orderBy("updated_at", "desc"));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ ...d.data(TIMESTAMP_OPTS), id: d.id })));
  });
}

export async function getProduct(id) {
  const snap = await getDoc(doc(dbFs, "products", id));
  return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

export async function saveProduct(product) {
  // Strip id from the stored fields in BOTH branches below — product-form.js
  // always includes `id` in the object it builds (null for a brand-new
  // product, the real id when editing), and this is the one place that
  // ever writes a whole product document. Missing this on the *create*
  // branch was a real, already-shipped bug: a new product's payload had
  // id: null spread into `payload` below, and nothing ever removed it
  // before addDoc — so every product created through this app got a
  // literal id: null field saved INSIDE its own document data (separate
  // from, and shadowing, the real auto-generated Firestore document id).
  // Every list/read function used to do `{ id: d.id, ...d.data() }`, and
  // object spread lets later keys win — so that stored `id: null` field
  // silently overwrote the real id on every product read afterward,
  // meaning every delete/edit/scan action on that product tried to
  // operate on "products/null" and failed. Fixed on both ends: this strip
  // on write, and id: d.id placed LAST (winning) on every read above.
  const { id: _ignoredId, ...productFields } = product;
  const payload = { ...productFields, updated_at: serverTimestamp(), updated_by: currentUserEmail() };
  if (product.id) {
    await setDoc(doc(dbFs, "products", product.id), payload, { merge: true });
    return product.id;
  }
  payload.created_at = serverTimestamp();
  payload.created_by = currentUserEmail();
  payload.deleted = false;
  const ref_ = await addDoc(collection(dbFs, "products"), payload);
  return ref_.id;
}

// Soft delete: products are never actually removed by normal use of the
// app — "Delete" just hides them (deleted: true) so a wrong click can be
// undone. True permanent removal only happens by clearing it out directly
// in the Firebase console, on purpose, separately from everyday use.
export async function archiveProduct(id) {
  await updateDoc(doc(dbFs, "products", id), {
    deleted: true,
    deleted_at: serverTimestamp(),
    deleted_by: currentUserEmail(),
  });
}

export async function restoreProduct(id) {
  await updateDoc(doc(dbFs, "products", id), {
    deleted: false,
    deleted_at: null,
    deleted_by: null,
  });
}

// Inline single-variant patch (quick-edit without reopening the modal, and
// the Live tab's scan-in/scan-out actions). Runs as a transaction — plain
// read-then-write here would lose an update if two staff scan/edit the
// same product's variants at close to the same moment (a real scenario
// for the Live tab specifically): both would read the same starting
// state, and whichever write lands second would silently overwrite the
// first's change. A transaction retries automatically if that happens
// instead of losing either update.
export async function patchVariant(productId, variantIndex, patch) {
  const productRef = doc(dbFs, "products", productId);
  await runTransaction(dbFs, async transaction => {
    const snap = await transaction.get(productRef);
    if (!snap.exists()) throw new Error("Product not found");
    const variants = [...(snap.data().variants || [])];
    variants[variantIndex] = { ...variants[variantIndex], ...patch };
    transaction.update(productRef, {
      variants,
      updated_at: serverTimestamp(),
      updated_by: currentUserEmail(),
    });
  });
}

// ---------- Backup ----------
// Pulls everything (categories, tags, every product including soft-deleted
// ones) into one plain object, for the "Download Backup" button in app.js.
// This is the safety net while there's no automatic server-side backup.
export async function exportAllData() {
  const [categories, tags, products] = await Promise.all([listCategories(), listTags(), listProducts()]);
  return {
    exported_at: new Date().toISOString(),
    categories: categories.map(serializeTimestamps),
    tags: tags.map(serializeTimestamps),
    products: products.map(serializeTimestamps),
  };
}

// Firestore Timestamp objects don't survive JSON.stringify as readable
// dates (they'd serialize as {} or internal fields) — convert every one,
// at any depth, to a plain ISO string so the backup file is actually
// human-readable and re-importable.
function serializeTimestamps(value) {
  if (value === null || value === undefined) return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeTimestamps);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeTimestamps(v);
    return out;
  }
  return value;
}

// ---------- Images ----------
export async function uploadProductImage(productId, file, order) {
  const path = `products/${productId}/${Date.now()}_${file.name}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  return { url, path, order, name: file.name };
}

export async function deleteProductImage(path) {
  try {
    await deleteObject(ref(storage, path));
  } catch (e) {
    console.warn("Image delete failed (may already be gone):", e.message);
  }
}
