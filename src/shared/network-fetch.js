// src/shared/network-fetch.js
// Network/data-source helpers. The side panel can fetch likely JSON
// endpoints through the content script, and page-world adapters can reuse
// the marker-shape helpers to scan window state, JSON-LD, inline JSON
// scripts, and any other JSON blob that might hold marker arrays.

const LAT_KEYS = ["lat", "latitude", "y", "Lat", "LAT", "Latitude", "LATITUDE"];
const LNG_KEYS = ["lng", "lon", "long", "longitude", "x", "Lng", "LNG", "LON", "Longitude", "LONGITUDE"];
const NESTED_COORD_KEYS = [
  "position", "Position",
  "coordinates", "coordinate", "coords", "Coords",
  "point", "Point",
  "location", "Location",
  "geo", "Geo",
  "latlng", "latLng", "LatLng",
  "lngLat", "lonLat",
  "center", "Center",
];

const ENDPOINT_POSITIVE_RE = /store|stores|location|locations|marker|markers|pin|pins|shop|shops|branch|branches|dealer|dealers|office|offices|clinic|clinics|hospital|hospitals|provider|providers|facility|facilities|search|nearby|near-?me|geojson|outlet|outlets|center|centers|centre|centres|place|places|pharmacy|pharmacies|atm|atms|kiosk|kiosks|find-?a|locator|where-?to|map-?data/i;
const ENDPOINT_NEGATIVE_RE = /tile|tiles|sprite|glyph|style|font|\.png|\.jpe?g|\.webp|\.svg|\.css|\.woff|\.ico|google-?analytics|googletagmanager|doubleclick|hotjar|fullstory|sentry/i;

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
    .sort((a, b) => b.score - a.score);
  // Prefer positive-score hits, but if there are none, accept the top
  // non-negative one — better than returning nothing on a site that names
  // its endpoint /data or /find without locator-y keywords.
  const positive = ranked.find((entry) => entry.score > 0);
  if (positive) return positive.request.url;
  const neutral = ranked.find((entry) => entry.score >= 0);
  return neutral?.request?.url || null;
}

export function scoreMarkerEndpoint(url, type = "") {
  if (!url) return 0;
  const lower = url.toLowerCase();
  let score = 0;
  if (type === "xmlhttprequest" || type === "fetch") score += 2;
  if (/\.json(?:\b|$|\?)/.test(lower)) score += 6;
  if (/format=json|type=json|f=json|output=json/.test(lower)) score += 4;
  if (/\/api\/|\/graphql|\/gql|\/geojson|\/v\d+\//.test(lower)) score += 4;
  if (ENDPOINT_POSITIVE_RE.test(lower)) score += 5;
  if (/bbox|bounds|lat|lng|lon|radius|near|distance|sw=|ne=/.test(lower)) score += 2;
  if (ENDPOINT_NEGATIVE_RE.test(lower)) score -= 8;
  return score;
}

// Walks an arbitrary JSON-ish value and returns every marker-shaped record
// it can find, deduped by lat/lng. Aggregates across multiple sibling
// arrays — common when a site keeps separate lists per category but
// presents them on one map.
export function findMarkerArray(root) {
  const candidates = [];

  const walk = (node, depth = 0) => {
    if (depth > 10 || !node) return;

    if (Array.isArray(node)) {
      // Pure coordinate array: [[lng,lat], [lng,lat], ...]
      // Useful when sites store positions detached from metadata.
      if (looksLikeCoordArray(node)) {
        candidates.push({
          size: node.length,
          coords: node.map(([lng, lat]) => ({ item: { lng, lat }, lat: Number(lat), lng: Number(lng) })),
        });
        return;
      }

      const coords = [];
      for (const item of node) {
        const c = asCoords(item);
        if (c) coords.push({ item, ...c });
      }
      // Accept "all items shaped like markers" or "≥3 items + ≥40% are markers".
      if (coords.length === node.length && coords.length > 0) {
        candidates.push({ size: coords.length, coords });
      } else if (coords.length >= Math.max(3, node.length * 0.4)) {
        candidates.push({ size: coords.length, coords });
      }
      for (const item of node) walk(item, depth + 1);
    } else if (typeof node === "object") {
      for (const value of Object.values(node)) walk(value, depth + 1);
    }
  };

  walk(root);
  if (candidates.length === 0) return [];

  // Dedupe by quantised lat/lng so duplicates across nested arrays merge.
  candidates.sort((a, b) => b.size - a.size);
  const seen = new Set();
  const out = [];
  for (const cand of candidates) {
    for (const { item, lat, lng } of cand.coords) {
      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(flattenMarkerItem(item, lat, lng));
    }
    // Stop after the first "complete" candidate has filled the set unless
    // there's another candidate that adds materially more rows.
    if (out.length > 0 && cand !== candidates[0] && cand.size < candidates[0].size * 0.25) break;
  }
  return out;
}

// True when a 2D array of length-2 numeric pairs looks like coordinates.
// Also requires the values to fall inside lat/lng ranges so we don't
// confuse 2D vector buffers with positions.
function looksLikeCoordArray(arr) {
  if (arr.length < 3) return false;
  let count = 0;
  for (const x of arr) {
    if (!Array.isArray(x) || x.length !== 2) return false;
    const a = Number(x[0]), b = Number(x[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    // Either ordering: [lng,lat] or [lat,lng]. Bias to [lng,lat] (GeoJSON).
    if (Math.abs(a) <= 180 && Math.abs(b) <= 90) count++;
  }
  return count === arr.length;
}

export function asCoords(obj) {
  if (!obj || typeof obj !== "object") return null;

  // GeoJSON Feature / Geometry
  if (obj.geometry?.type === "Point" && Array.isArray(obj.geometry.coordinates)) {
    const [lng, lat] = obj.geometry.coordinates.map(Number);
    if (validLatLng(lat, lng)) return { lat, lng };
  }
  if (obj.type === "Point" && Array.isArray(obj.coordinates)) {
    const [lng, lat] = obj.coordinates.map(Number);
    if (validLatLng(lat, lng)) return { lat, lng };
  }

  // Direct lat/lng pair on the item itself.
  const lat0 = pickNumeric(obj, LAT_KEYS);
  const lng0 = pickNumeric(obj, LNG_KEYS);
  if (validLatLng(lat0, lng0)) return { lat: lat0, lng: lng0 };

  // Nested wrappers: position/coords/point/location/geo/center/etc.
  for (const key of NESTED_COORD_KEYS) {
    const nested = obj[key];
    if (!nested) continue;
    if (Array.isArray(nested) && nested.length >= 2) {
      const a = Number(nested[0]), b = Number(nested[1]);
      // GeoJSON convention: [lng, lat]
      if (validLatLng(b, a)) return { lat: b, lng: a };
      if (validLatLng(a, b)) return { lat: a, lng: b };
    } else if (typeof nested === "object") {
      const sub = asCoords(nested);
      if (sub) return sub;
    } else if (typeof nested === "string") {
      const parsed = parseCoordString(nested);
      if (parsed) return parsed;
    }
  }

  // ESRI-style: { attributes: {...}, geometry: { x, y, spatialReference } }
  if (obj.attributes && obj.geometry && Number.isFinite(Number(obj.geometry.x)) && Number.isFinite(Number(obj.geometry.y))) {
    const x = Number(obj.geometry.x);
    const y = Number(obj.geometry.y);
    // ESRI returns lng/lat in WGS84; in projected systems the values look
    // out of range and we drop them (we don't reproject in the page).
    if (validLatLng(y, x)) return { lat: y, lng: x };
  }

  // String-encoded coordinate field, e.g. obj.location = "12.97,77.59".
  for (const key of ["location", "coords", "coordinate", "latlng", "latLng", "geo"]) {
    if (typeof obj[key] === "string") {
      const parsed = parseCoordString(obj[key]);
      if (parsed) return parsed;
    }
  }

  return null;
}

function flattenMarkerItem(item, lat, lng) {
  const out = { lat, lng };
  if (!item || typeof item !== "object") return out;

  const isGeoJSONFeature = item.type === "Feature" && item.geometry?.type === "Point";
  const source = isGeoJSONFeature ? (item.properties || {}) : item;

  for (const [key, value] of Object.entries(source)) {
    if (LAT_KEYS.includes(key) || LNG_KEYS.includes(key)) continue;
    if (NESTED_COORD_KEYS.includes(key)) continue;       // already encoded via lat/lng
    if (value === null || value === undefined) continue;
    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      // Keep small primitive arrays as comma-joined strings.
      if (value.length <= 8 && value.every((v) => v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
        out[key] = value.filter((v) => v != null).join(", ");
      }
    } else if (type === "object") {
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

// Coordinate-range gate. Drops common placeholder values so a row of
// fake (0, 0) entries doesn't out-vote the real array.
export function validLatLng(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

// Parse "lat,lng" (most common) or "lng,lat" when the first token is
// clearly out of latitude range.
export function parseCoordString(s) {
  const m = String(s).match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ;|]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
    return validLatLng(b, a) ? { lat: b, lng: a } : null;
  }
  return validLatLng(a, b) ? { lat: a, lng: b } : null;
}
