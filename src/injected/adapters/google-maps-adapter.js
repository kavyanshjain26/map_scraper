// src/injected/adapters/google-maps-adapter.js
// Google Maps JavaScript API v3.
//
// There's no map/marker registry in the public API, so we hook three
// constructors at load time:
//   - google.maps.Map
//   - google.maps.Marker                        (legacy)
//   - google.maps.marker.AdvancedMarkerElement  (current)
//
// The `marker` library is loaded lazily via await google.maps.importLibrary
// on modern apps, so the hook has to re-check periodically. Our 100-try
// interval covers that.
//
// Enumeration: filter the marker registry by `.map === ourMap` (both marker
// types use the same property). InfoWindow content is on the Marker itself
// usually via `.infoWindowContent` or on click handlers, so we can't always
// extract it without triggering a click. We return title/label/position
// reliably, plus whatever custom props the site attached.
//
// Clustering: MarkerClusterer is third-party. If the site uses it, the
// underlying markers are still in our registry (clusterer just draws
// cluster bubbles on top), so we get them for free.
//
// TOS REMINDER: scraping Google Places data is forbidden. Scraping a third-
// party site that uses Google Maps to display its OWN data is usually fine.

import { BaseAdapter } from "./base-adapter.js";

const MAP_INSTANCES    = (window.__MMS_GOOGLE_INSTANCES__        ||= []);
const MARKER_INSTANCES = (window.__MMS_GOOGLE_MARKER_INSTANCES__ ||= []);

export function installGoogleHook() {
  if (window.__MMS_GOOGLE_HOOKED__ && window.__MMS_GOOGLE_MARKERS_HOOKED__) return;

  const tryHookMap = () => {
    const g = window.google?.maps;
    if (!g?.Map) return false;
    if (g.Map.__mmsHooked) return true;
    const Original = g.Map;
    function Hooked(...args) {
      const inst = new Original(...args);
      try { MAP_INSTANCES.push(inst); } catch (_) {}
      return inst;
    }
    Hooked.prototype = Original.prototype;
    Object.setPrototypeOf(Hooked, Original);
    Hooked.__mmsHooked = true;
    g.Map = Hooked;
    window.__MMS_GOOGLE_HOOKED__ = true;
    return true;
  };

  const tryHookMarkers = () => {
    const g = window.google?.maps;
    if (!g) return false;
    let done = true;

    // Legacy Marker
    if (g.Marker && !g.Marker.__mmsHooked) {
      const Original = g.Marker;
      function Hooked(...args) {
        const inst = new Original(...args);
        let originalMap = null;
        if (args[0] && typeof args[0] === "object") originalMap = args[0].map || null;
        try { MARKER_INSTANCES.push({ kind: "marker", marker: inst, originalMap }); } catch (_) {}
        return inst;
      }
      Hooked.prototype = Original.prototype;
      Object.setPrototypeOf(Hooked, Original);
      Hooked.__mmsHooked = true;
      g.Marker = Hooked;
    } else if (!g.Marker) {
      done = false;  // might still load later
    }

    // AdvancedMarkerElement lives under g.marker. Lazy-loaded library.
    const am = g.marker?.AdvancedMarkerElement;
    if (am && !am.__mmsHooked) {
      const Original = am;
      function Hooked(...args) {
        const inst = new Original(...args);
        let originalMap = null;
        if (args[0] && typeof args[0] === "object") originalMap = args[0].map || null;
        try { MARKER_INSTANCES.push({ kind: "advanced", marker: inst, originalMap }); } catch (_) {}
        return inst;
      }
      Hooked.prototype = Original.prototype;
      Object.setPrototypeOf(Hooked, Original);
      Hooked.__mmsHooked = true;
      g.marker.AdvancedMarkerElement = Hooked;
    } else if (!g.marker) {
      done = false;  // marker library not imported yet
    }

    if (done) window.__MMS_GOOGLE_MARKERS_HOOKED__ = true;
    return done;
  };

  if (tryHookMap() && tryHookMarkers()) return;

  let tries = 0;
  const timer = setInterval(() => {
    tryHookMap();
    tryHookMarkers();
    if (++tries > 100) clearInterval(timer);
  }, 100);
}

export class GoogleMapsAdapter extends BaseAdapter {
  static get name() { return "Google Maps"; }

  async detect() {
    const hooked = MAP_INSTANCES.slice();
    const hasGlobal = !!window.google?.maps;
    if (hooked.length === 0 && !hasGlobal) {
      return { confidence: 0, reason: "no google.maps", instances: [] };
    }
    if (hooked.length > 0) {
      return {
        confidence: 0.9,
        reason: `hooked ${hooked.length} google.maps.Map instance(s)`,
        instances: hooked.map(m => ({ kind: "live", map: m })),
      };
    }
    return { confidence: 0.3, reason: "google.maps present, hook missed construction", instances: [] };
  }

  async enumerateMarkers(instance, { expandClusters = true, deepScan = false } = {}) {
    if (instance.kind !== "live") {
      throw new Error("Google Maps DOM-only enumeration not supported — reload with the extension active");
    }
    const map = instance.map;

    // If the page lazy-loads markers based on viewport (very common pattern
    // for store locators), pan/zoom across the map to trigger fetches.
    // Otherwise we'd only see whatever's currently visible.
    if (deepScan) {
      await deepScanGoogle(map);
    } else if (expandClusters) {
      // Cheap zoom-out: many sites' clusters hide most markers. Try a brief
      // zoom-out sequence so MarkerClusterer's full set gets registered.
      await briefZoomOutGoogle(map);
    }

    return collectGoogleMarkers(map);
  }

  async extractMarkerData(record, schemaHint = null) {
    const { lat, lng, raw } = record;
    const out = { lat, lng };
    const m = raw.marker;

    // Fast direct properties first.
    if (raw.kind === "marker") {
      const title = m.getTitle?.();
      if (title) out.title = title;
      const label = m.getLabel?.();
      if (label) out.label = typeof label === "string" ? label : (label.text || "");
    } else {
      if (m.title) out.title = m.title;
      if (m.content instanceof HTMLElement) {
        const text = (m.content.textContent || "").trim();
        if (text) out.content_text = text;
      }
    }

    // When schemaHint is present, the user wants popup fields. On most
    // Google Maps sites the popup (InfoWindow) is created lazily by the
    // site's own click handler — it's not on the marker. So we trigger
    // the click, wait for the InfoWindow to appear in the DOM, and
    // apply the selectors to it.
    if (schemaHint?.fields?.length) {
      const iw = await openInfoWindow(m, raw.kind);
      if (iw) {
        Object.assign(out, applySchema(iw, schemaHint));
      }
    }

    return out;
  }
}

// Collect every hooked marker that belongs (now or originally) to this map.
// We accept markers whose .map is currently null because cluster libraries
// like @googlemaps/markerclusterer detach markers from the map while they
// live inside a cluster bubble. Filtering only by current .map would lose
// those — i.e. lose every clustered point on the page.
function collectGoogleMarkers(map) {
  const out = [];
  const seen = new Set();
  let id = 0;
  const onlyMap = MAP_INSTANCES.length <= 1;

  for (const rec of MARKER_INSTANCES) {
    const m = rec.marker;
    const currentMap = rec.kind === "marker" ? m.getMap?.() : m.map;
    const belongs =
      currentMap === map ||
      rec.originalMap === map ||
      (onlyMap && (currentMap == null && rec.originalMap == null));
    if (!belongs) continue;

    let lat, lng;
    if (rec.kind === "marker") {
      const pos = m.getPosition?.();
      if (!pos) continue;
      lat = typeof pos.lat === "function" ? pos.lat() : pos.lat;
      lng = typeof pos.lng === "function" ? pos.lng() : pos.lng;
    } else {
      const p = m.position;
      if (!p) continue;
      lat = typeof p.lat === "function" ? p.lat() : p.lat;
      lng = typeof p.lng === "function" ? p.lng() : p.lng;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    // Dedupe by lat/lng (4 decimals ≈ 11m tolerance).
    const k = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (seen.has(k)) continue;
    seen.add(k);

    out.push({
      id: `google-${rec.kind}-${id++}`,
      lat, lng,
      raw: rec,
    });
  }
  return out;
}

// Wait for the map to settle (idle event) — emitted when tiles are loaded
// and any pending pan/zoom animation has finished.
function waitIdle(map, timeoutMs = 2500) {
  const g = window.google?.maps;
  return new Promise((resolve) => {
    if (!g?.event) { setTimeout(resolve, timeoutMs); return; }
    const t = setTimeout(resolve, timeoutMs);
    const listener = g.event.addListenerOnce(map, "idle", () => {
      clearTimeout(t);
      resolve();
    });
    // Safety: also resolve if listener registration silently fails.
    if (!listener) { clearTimeout(t); resolve(); }
  });
}

// One-shot zoom-out + back-in. Cheap nudge to make MarkerClusterer dump its
// full marker set (some implementations only register markers once visible).
async function briefZoomOutGoogle(map) {
  try {
    const z = map.getZoom?.();
    if (typeof z !== "number") return;
    if (z > 3) {
      map.setZoom(Math.max(2, z - 4));
      await waitIdle(map, 1500);
      map.setZoom(z);
      await waitIdle(map, 1500);
    }
  } catch (_) { /* best-effort */ }
}

// Pan-and-zoom sweep. Drives the map across a 3x3 grid at multiple zoom
// levels. Triggers viewport-bound AJAX loaders. Pages already-known markers
// remain in MARKER_INSTANCES; new ones get added by our constructor hook.
async function deepScanGoogle(map) {
  const g = window.google?.maps;
  if (!g?.LatLng) return;

  const startCenter = map.getCenter?.();
  const startZoom = map.getZoom?.();

  // Step 1: try to fit known markers, then zoom out further to trigger
  // global-bounds queries.
  const known = collectGoogleMarkers(map);
  let north = 60, south = -55, east = 170, west = -170;   // continental fallback
  if (known.length >= 2) {
    north = Math.max(...known.map(m => m.lat));
    south = Math.min(...known.map(m => m.lat));
    east  = Math.max(...known.map(m => m.lng));
    west  = Math.min(...known.map(m => m.lng));
    // Pad 20%
    const padLat = Math.max(0.5, (north - south) * 0.2);
    const padLng = Math.max(0.5, (east  - west)  * 0.2);
    north += padLat; south -= padLat;
    east  += padLng; west  -= padLng;
  }

  try {
    const bounds = new g.LatLngBounds(
      new g.LatLng(south, west),
      new g.LatLng(north, east),
    );
    map.fitBounds(bounds);
    await waitIdle(map, 2500);
  } catch (_) { /* ignore */ }

  // Step 2: 3x3 pan grid at the fitted zoom.
  const grid = 3;
  const fitZoom = map.getZoom?.() ?? 4;
  const stepLat = (north - south) / grid;
  const stepLng = (east  - west)  / grid;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const lat = south + stepLat * (i + 0.5);
      const lng = west  + stepLng * (j + 0.5);
      try {
        map.setCenter(new g.LatLng(lat, lng));
        map.setZoom(Math.max(fitZoom + 1, 6));
        await waitIdle(map, 1500);
      } catch (_) { /* ignore */ }
    }
  }

  // Step 3: restore initial viewport so the user's view isn't disturbed.
  try {
    if (startCenter) map.setCenter(startCenter);
    if (typeof startZoom === "number") map.setZoom(startZoom);
    await waitIdle(map, 1000);
  } catch (_) { /* ignore */ }
}

// Click the marker and wait for an InfoWindow to render in the DOM.
// Returns the InfoWindow root element, or null on timeout.
async function openInfoWindow(marker, kind, timeoutMs = 1000) {
  const g = window.google?.maps;
  if (!g?.event?.trigger) return null;

  const existing = document.querySelector(".gm-style-iw-c");
  const existingText = existing ? (existing.textContent || "") : "";

  try {
    // Works for both legacy google.maps.Marker and AdvancedMarkerElement
    // since they share the same event bus.
    g.event.trigger(marker, "click");
  } catch (_) {
    // Fallback for AdvancedMarkerElement: dispatch a DOM click on its
    // content element.
    if (kind === "advanced" && marker.content?.dispatchEvent) {
      try {
        marker.content.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } catch (_) { /* ignore */ }
    }
  }

  // Poll for the InfoWindow. We require either (a) no InfoWindow was
  // present before and one appeared, or (b) one was present and its
  // text content changed (new marker's data loaded).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(40);
    const iw = document.querySelector(".gm-style-iw-c");
    if (!iw) continue;
    const text = (iw.textContent || "").trim();
    if (!text) continue;
    if (text !== existingText) {
      // Give the popup one more tick for async children (images, links).
      await sleep(30);
      return document.querySelector(".gm-style-iw-c") || iw;
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function applySchema(rootEl, schemaHint) {
  const out = {};
  for (const f of schemaHint.fields || []) {
    const el = rootEl.querySelector(f.selector);
    if (el) out[f.key] = (el.textContent || "").trim();
  }
  return out;
}
