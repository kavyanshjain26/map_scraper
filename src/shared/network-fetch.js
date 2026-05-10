// src/shared/network-fetch.js
// Network/data-source helpers. The side panel can fetch likely JSON
// endpoints through the content script, and page-world adapters can reuse
// the marker-shaped JSON walker for exposed data arrays.

const LAT_KEYS = ["lat", "latitude", "y", "Lat", "LAT", "Latitude"];
const LNG_KEYS = ["lng", "lon", "long", "longitude", "x", "Lng", "LNG", "LON", "Longitude"];
const ENDPOINT_POSITIVE_RE = /store|stores|location|locations|marker|markers|pin|pins|shop|branch|dealer|office|clinic|hospital|provider|facility|search|nearby|geojson/i;
const ENDPOINT_NEGATIVE_RE = /tile|tiles|sprite|glyph|style|font|\.png|\.jpe?g|\.webp|\.svg|\.css|\.woff|google|mapbox|maplibre/i;

export async function networkFetchMarkers(tabId, url, options = {}) {
  const reply = await chrome.tabs.sendMessage(tabId, {
    type: "FETCH_URL",
    payload: { url, headers: options.headers || {} },
  });
  if (!reply?.ok) throw new Error(reply?.error || "Fetch failed");
  const { status, text } = reply.result;
  if (status >= 400) throw new Error(`HTTP ${status}`);

  const markers = extractMarkersFromJsonText(text);
  if (!markers || markers.length === 0) {
    throw new Error("No marker-shaped array found in response");
  }
  return markers;
}

export function extractMarkersFromJsonText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error("Response isn't JSON - can't auto-parse");
  }
  return findMarkerArray(parsed);
}

export function pickBestMarkerEndpoint(requests) {
  const ranked = (requests || [])
    .map((request) => ({
      request,
      score: scoreMarkerEndpoint(request?.url || "", request?.type || ""),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.request?.url || null;
}

export function scoreMarkerEndpoint(url, type = "") {
  if (!url) return 0;
  const lower = url.toLowerCase();
  let score = 0;
  if (type === "xmlhttprequest" || type === "fetch") score += 2;
  if (/\.json(?:\b|$|\?)/.test(lower)) score += 6;
  if (/\/api\/|\/graphql|\/geojson/.test(lower)) score += 4;
  if (ENDPOINT_POSITIVE_RE.test(lower)) score += 5;
  if (/bbox|bounds|lat|lng|lon|radius|near/.test(lower)) score += 2;
  if (ENDPOINT_NEGATIVE_RE.test(lower)) score -= 8;
  return score;
}

export function findMarkerArray(root) {
  const candidates = [];

  const walk = (node, depth = 0) => {
    if (depth > 8 || !node) return;

    if (Array.isArray(node)) {
      let hits = 0;
      const coords = [];
      for (const item of node) {
        const c = asCoords(item);
        if (c) {
          hits++;
          coords.push({ item, ...c });
        }
      }
      if (hits > 0 && hits === node.length) {
        candidates.push({ size: hits, coords });
      } else if (hits > Math.max(3, node.length * 0.5)) {
        candidates.push({ size: hits, coords });
      }
      for (const item of node) walk(item, depth + 1);
    } else if (typeof node === "object") {
      for (const value of Object.values(node)) walk(value, depth + 1);
    }
  };

  walk(root);
  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0].coords.map(({ item, lat, lng }) => flattenMarkerItem(item, lat, lng));
}

export function asCoords(obj) {
  if (!obj || typeof obj !== "object") return null;

  if (obj.geometry?.type === "Point" && Array.isArray(obj.geometry.coordinates)) {
    const [lng, lat] = obj.geometry.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }

  const lat = pickNumeric(obj, LAT_KEYS);
  const lng = pickNumeric(obj, LNG_KEYS);
  if (lat !== null && lng !== null) return { lat, lng };
  return null;
}

function flattenMarkerItem(item, lat, lng) {
  const out = { lat, lng };
  if (!item || typeof item !== "object") return out;

  const isGeoJSONFeature = item.type === "Feature" && item.geometry?.type === "Point";
  const source = isGeoJSONFeature ? (item.properties || {}) : item;

  for (const [key, value] of Object.entries(source)) {
    if (LAT_KEYS.includes(key) || LNG_KEYS.includes(key)) continue;
    if (value === null || value === undefined) continue;
    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") out[key] = value;
    else if (type === "object" && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value)) {
        const subType = typeof subValue;
        if (subType === "string" || subType === "number" || subType === "boolean") {
          out[`${key}_${subKey}`] = subValue;
        }
      }
    }
  }
  return out;
}

function pickNumeric(obj, keys) {
  for (const key of keys) {
    if (key in obj) {
      const value = Number(obj[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}
