// One compact, read-only snapshot of the structured size/weight guides saved
// in VHM Live Log. Live Log publishes kv/live_guides_v1 whenever a guide changes.

import { plain } from "./live-feed.js";

const URL = "https://firestore.googleapis.com/v1/projects/vhm-catalog/databases/(default)/documents/kv/live_guides_v1?key=AIzaSyDDQp5_gvuRdX0flKQ3gm3zXJM_SXWUJSE";
const LS = "vhminv_live_guides_v1";

let payload = null, byCode = new Map(), err = "", checking = null, started = false;
const listeners = new Set();
const norm = value => String(value || "").trim().toUpperCase();

function adopt(value) {
  if (!value || value.schema !== "vhm-live-guides" || value.version !== 1 || !value.guides) return false;
  payload = value;
  byCode = new Map(Object.entries(value.guides).map(([code, guide]) => [norm(code), guide]));
  listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  return true;
}

export const liveGuideFor = code => byCode.get(norm(code)) || null;
export const liveGuidesError = () => err;
export const onLiveGuides = fn => { listeners.add(fn); return () => listeners.delete(fn); };

export function startLiveGuides() {
  if (!started) {
    started = true;
    try { adopt(JSON.parse(localStorage.getItem(LS) || "null")); } catch (e) {}
  }
  return checkLiveGuides();
}

export function checkLiveGuides() {
  if (checking) return checking;
  checking = (async () => {
    try {
      const res = await fetch(URL);
      if (res.status === 404) { err = "Live Log has not published its weight guides yet"; return; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const doc = await res.json();
      let value = plain(doc.fields?.data);
      if (typeof value === "string") value = JSON.parse(value);
      if (!value || value.schema !== "vhm-live-guides") throw new Error("unexpected guide snapshot");
      err = "";
      if (!payload || payload.hash !== value.hash) {
        adopt(value);
        try { localStorage.setItem(LS, JSON.stringify(value)); } catch (e) {}
      }
    } catch (e) {
      err = "Live weight guides not updated: " + e.message;
      console.warn(err);
    } finally {
      checking = null;
    }
  })();
  return checking;
}
