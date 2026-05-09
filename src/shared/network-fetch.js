// src/shared/network-fetch.js
// Network-replay "adapter" — orthogonal to the library adapters. Used when
// the map renders to WebGL / canvas and DOM enumeration gives nothing, or
// when the site exposes a clean JSON endpoint we can just hit directly.
//
// The user teaches the extension which URL holds the marker data by
// clicking that URL in the captured-requests list. We save the URL in the
// site's profile. On enumerate, we fetch it (in the content script's
// isolated world so cookies work), parse the JSON, and walk it looking
// for arrays of objects with lat/lng-like fields.

const LAT_KEYS = ["lat", "latitude", "y", "Lat", "LAT", "Latitude"];
const LNG_KEYS = ["lng", "lon", "long", "longitude", "x", "Lng", "LNG", "LON", "Longitude"];

/**
 * Fetch a URL via the content script and parse its body.
 * Called from the sidepanel.
 */
export async function networkFetchMarkers(tabId, url, options = {}) {
  const reply = await chrome.tabs.sendMessage(tabId, {
    type: "FETCH_URL",
    payload: { url, headers: options.headers || {} },
  });
  if (!reply?.ok) throw new Error(reply?.error || "Fetch failed");
  const { status, text } = reply.result;
  if (status >= 400) throw new Error(`HTTP ${status}`);

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error("Response isn't JSON — can't auto-parse"); }

  const markers = findMarkerArray(parsed);
  if (!markers || markers.length === 0) {
    throw new Error("No marker-shaped array found in response");
  }
  return markers;
}

/**
 * Walk an arbitrary JSON structure looking for the largest array of
 * objects that each have a pair of lat/lng-like numeric fields. Returns
 * the array flattened to { lat, lng, ...otherFields } records.
 *
 * This is deliberately forgiving — real APIs wrap marker arrays under
 * keys like "results", "features", "data.locations", and use different
 * coordinate key names.
 */
export function findMarkerArray(root) {
  const candidates = [];

  const walk = (node, depth = 0) => {
    if (depth > 8) return;
    if (!node) return;

    if (Array.isArray(node)) {
      // Count how many items look like markers.
      let hits = 0;
      const coords = [];
      for (const item of node) {
        const c = asCoords(item);
        if (c) { hits++; coords.push({ item, ...c }); }
      }
      if (hits > 0 && hits === node.length) {
        candidates.push({ size: hits, coords });
      } else if (hits > Math.max(3, node.length * 0.5)) {
        // Mostly-markers array, partial.
        candidates.push({ size: hits, coords });
      }
      // Recurse into items even if this array was a hit — some APIs
      // nest further.
      for (const item of node) walk(item, depth + 1);
    } else if (typeof node === "object") {
      for (const v of Object.values(node)) walk(v, depth + 1);
    }
  };

  walk(root);
  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0].coords.map(({ item, lat, lng }) => {
    const out = { lat, lng };
    if (!item || typeof item !== "object") return out;

    // GeoJSON Feature: the useful fields are in .properties. Flatten
    // those to top level and skip the outer type/geometry wrappers.
    const isGeoJSONFeature =
      item.type === "Feature" && item.geometry?.type === "Point";

    const source = isGeoJSONFeature ? (item.properties || {}) : item;

    for (const [k, v] of Object.entries(source)) {
      if (LAT_KEYS.includes(k) || LNG_KEYS.includes(k)) continue;
      if (v === null || v === undefined) continue;
      const t = typeof v;
      if (t === "string" || t === "number" || t === "boolean") out[k] = v;
      else if (t === "object" && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          const t2 = typeof v2;
          if (t2 === "string" || t2 === "number" || t2 === "boolean") {
            out[`${k}_${k2}`] = v2;
          }
        }
      }
    }
    return out;
  });
}

// Does this object look like a point with lat + lng? Handles GeoJSON
// Feature (geometry.coordinates), flat {lat, lng}, and common variants.
function asCoords(obj) {
  if (!obj || typeof obj !== "object") return null;

  // GeoJSON Feature
  if (obj.geometry?.type === "Point" && Array.isArray(obj.geometry.coordinates)) {
    const [lng, lat] = obj.geometry.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }

  // Direct coordinates array [lng, lat] (common mistake: [lat, lng])
  // — we don't handle bare-array items because we can't distinguish
  // the two orderings without context.

  const lat = pickNumeric(obj, LAT_KEYS);
  const lng = pickNumeric(obj, LNG_KEYS);
  if (lat !== null && lng !== null) return { lat, lng };
  return null;
}

function pickNumeric(obj, keys) {
  for (const k of keys) {
    if (k in obj) {
      const v = Number(obj[k]);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}
