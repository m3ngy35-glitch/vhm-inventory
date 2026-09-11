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
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const dbFs = getFirestore(app);
export const storage = getStorage(app);

// ---------- Categories ----------
export async function listCategories() {
  const snap = await getDocs(query(collection(dbFs, "categories"), orderBy("name")));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function saveCategory(cat) {
  if (cat.id) {
    const { id, ...rest } = cat;
    await updateDoc(doc(dbFs, "categories", id), rest);
    return id;
  }
  const ref_ = await addDoc(collection(dbFs, "categories"), cat);
  return ref_.id;
}
export async function deleteCategory(id) {
  await deleteDoc(doc(dbFs, "categories", id));
}

// ---------- Tags ----------
export async function listTags() {
  const snap = await getDocs(query(collection(dbFs, "tags"), orderBy("name")));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function saveTag(tag) {
  if (tag.id) {
    const { id, ...rest } = tag;
    await updateDoc(doc(dbFs, "tags", id), rest);
    return id;
  }
  const ref_ = await addDoc(collection(dbFs, "tags"), tag);
  return ref_.id;
}
export async function deleteTag(id) {
  await deleteDoc(doc(dbFs, "tags", id));
}

// ---------- Products (with embedded variants array — simplest reliable
// model for Firestore at boutique scale; avoids the "shared-blob" bug
// pattern from earlier tools since each product is its own document) ----
export async function listProducts() {
  const snap = await getDocs(query(collection(dbFs, "products"), orderBy("updated_at", "desc")));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export function subscribeProducts(callback) {
  // live updates — multiple staff editing at once stay in sync
  const q = query(collection(dbFs, "products"), orderBy("updated_at", "desc"));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export async function getProduct(id) {
  const snap = await getDoc(doc(dbFs, "products", id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function saveProduct(product) {
  const payload = { ...product, updated_at: serverTimestamp() };
  if (product.id) {
    const { id, ...rest } = payload;
    await setDoc(doc(dbFs, "products", id), rest, { merge: false });
    return id;
  }
  payload.created_at = serverTimestamp();
  const ref_ = await addDoc(collection(dbFs, "products"), payload);
  return ref_.id;
}

export async function deleteProduct(id) {
  await deleteDoc(doc(dbFs, "products", id));
}

// Inline single-variant patch (quick-edit without reopening the modal)
export async function patchVariant(productId, variantIndex, patch) {
  const product = await getProduct(productId);
  if (!product) throw new Error("Product not found");
  const variants = [...(product.variants || [])];
  variants[variantIndex] = { ...variants[variantIndex], ...patch };
  await updateDoc(doc(dbFs, "products", productId), {
    variants,
    updated_at: serverTimestamp(),
  });
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
