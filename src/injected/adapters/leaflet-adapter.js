// src/injected/adapters/leaflet-adapter.js
// Reference implementation. Leaflet is the friendliest library to adapt:
// - window.L is a well-known global
// - Markers are in L.LayerGroup / L.FeatureGroup children
// - Leaflet.markercluster exposes getAllChildMarkers() on cluster groups —
//   so we can enumerate clustered markers WITHOUT zooming the map
//
// The hard part is finding the L.Map *instances*. Leaflet doesn't keep a
// registry of its own maps. Three strategies, tried in order:
//   A) Monkey-patch L.Map.prototype.initialize the moment L appears, so
//      every future map() call registers itself. This is what production
//      code should do — it's why page-script.js runs at document_start.
//   B) Walk the DOM for .leaflet-container elements and try to recover
//      the L.Map instance from known-ish internal properties. Leaflet
//      attaches _leaflet_id to DOM nodes but does NOT store the Map
//      object on the node. We can still detect "this is a Leaflet map
//      container" with high confidence.
//   C) Globals sweep — iterate window.* looking for objects that look
//      like L.Map. Last resort; slow, noisy, dangerous on big pages.
//
// We do A + B. If A caught the map at construction time, great. If not,
// we fall back to (B) and extract markers via the DOM layer, which is
// less complete but workable.

import { BaseAdapter } from "./base-adapter.js";

// Array of every L.Map instance we've seen, populated by the init hook.
// Global on the page world — one per page load.
const INSTANCES = (window.__MMS_LEAFLET_INSTANCES__ ||= []);

// Install the hook ASAP. Safe to call multiple times.
export function installLeafletHook() {
  if (window.__MMS_LEAFLET_HOOKED__) return;

  const tryHook = () => {
    const L = window.L;
    if (!L || !L.Map || !L.Map.prototype || !L.Map.prototype.initialize) return false;
    if (L.Map.prototype.__mmsHooked) return true;

    const original = L.Map.prototype.initialize;
    L.Map.prototype.initialize = function (...args) {
      const result = original.apply(this, args);
      try { INSTANCES.push(this); } catch (_) { /* ignore */ }
      return result;
    };
    L.Map.prototype.__mmsHooked = true;
    window.__MMS_LEAFLET_HOOKED__ = true;
    return true;
  };

  if (tryHook()) return;

  // L isn't loaded yet. Poll briefly; if it never shows up, give up quietly.
  let tries = 0;
  const timer = setInterval(() => {
    if (tryHook() || ++tries > 50) clearInterval(timer);
  }, 100);
}

export class LeafletAdapter extends BaseAdapter {
  static get name() { return "Leaflet"; }

  async detect() {
    const hookedInstances = INSTANCES.slice();

    // Even if the hook missed the construction, the DOM is a strong signal.
    const containers = Array.from(document.querySelectorAll(".leaflet-container"));

    if (hookedInstances.length === 0 && containers.length === 0) {
      return { confidence: 0, reason: "no leaflet instances or containers", instances: [] };
    }

    // Prefer hooked instances (we have full library access). Fall back to
    // container elements — the enumerator will do what it can with DOM.
    if (hookedInstances.length > 0) {
      return {
        confidence: 0.95,
        reason: `hooked ${hookedInstances.length} L.Map instance(s)`,
        instances: hookedInstances.map(m => ({ kind: "live", map: m })),
      };
    }

    return {
      confidence: 0.7,
      reason: `${containers.length} .leaflet-container(s), hook missed construction`,
      instances: containers.map(el => ({ kind: "dom-only", el })),
    };
  }

  async enumerateMarkers(instance, { expandClusters = true, deepScan = false } = {}) {
    if (instance.kind === "live") {
      if (deepScan) {
        await deepScanLeaflet(instance.map);
      }
      return enumerateFromLiveMap(instance.map, { expandClusters });
    }
    return enumerateFromDOM(instance.el);
  }

  async extractMarkerData(markerRecord, schemaHint = null) {
    const { lat, lng, raw } = markerRecord;
    const out = { lat, lng };

    // Try common Leaflet marker surfaces. Order matters — cheaper first.
    if (raw && typeof raw === "object") {
      // 1. Tooltip text (often a store name).
      const tooltip = raw.getTooltip?.();
      if (tooltip) {
        const t = tooltip.getContent?.();
        if (typeof t === "string" && t.trim()) out.tooltip = t.trim();
      }

      // 2. Popup content. getPopup() returns null until bindPopup has been
      //    called; but if content was passed as a string we can still read it.
      const popup = raw.getPopup?.();
      if (popup) {
        const content = popup.getContent?.();
        if (typeof content === "string") {
          out.popup_html = content;
        } else if (content instanceof HTMLElement) {
          out.popup_html = content.outerHTML;
        }
      }

      // 3. options.title and options.alt — set via L.marker(..., { title, alt }).
      if (raw.options?.title) out.title = raw.options.title;
      if (raw.options?.alt)   out.alt   = raw.options.alt;

      // 4. Custom properties. Some sites attach site-specific data here.
      //    Cherry-pick safe keys; never dump arbitrary options (circular refs).
      for (const key of ["id", "storeId", "name", "address", "data"]) {
        if (raw.options && raw.options[key] !== undefined) {
          out[`opt_${key}`] = raw.options[key];
        }
      }
    }

    // If a schemaHint says "parse popup_html with these selectors", do that.
    if (schemaHint && out.popup_html) {
      Object.assign(out, applySchemaHint(out.popup_html, schemaHint));
    }

    return out;
  }
}

// ---------- internals ----------

// Wait for the map to settle. Leaflet emits a flurry of events; "moveend"
// and "load" cover both pan and tile-load. Falls back to a timeout.
function waitLeafletIdle(map, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    const handler = () => { clearTimeout(t); map.off?.("moveend", handler); resolve(); };
    map.once?.("moveend", handler);
  });
}

// Pan+zoom sweep. Fits to known markers (or world bounds), then steps
// through a 3x3 grid at progressively higher zoom levels so any
// viewport-bound AJAX loader (very common pattern: the site listens to
// 'moveend' and fetches markers in the new bounds) gets exercised.
async function deepScanLeaflet(map) {
  const L = window.L;
  if (!L) return;

  const startCenter = map.getCenter?.();
  const startZoom = map.getZoom?.();

  // Try to fit world or known marker bounds.
  let bounds = null;
  const known = enumerateFromLiveMap(map, { expandClusters: true });
  if (known.length >= 2) {
    bounds = L.latLngBounds(known.map(m => [m.lat, m.lng])).pad(0.2);
  } else {
    bounds = L.latLngBounds([[-55, -170], [60, 170]]);
  }

  try {
    map.fitBounds(bounds, { animate: false });
    await waitLeafletIdle(map);
  } catch (_) { /* ignore */ }

  const south = bounds.getSouth();
  const west  = bounds.getWest();
  const north = bounds.getNorth();
  const east  = bounds.getEast();
  const fitZoom = map.getZoom?.() ?? 4;

  const grid = 3;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const lat = south + ((north - south) / grid) * (i + 0.5);
      const lng = west  + ((east  - west)  / grid) * (j + 0.5);
      try {
        map.setView([lat, lng], Math.max(fitZoom + 1, 6), { animate: false });
        await waitLeafletIdle(map);
      } catch (_) { /* ignore */ }
    }
  }

  // Restore.
  try {
    if (startCenter && typeof startZoom === "number") {
      map.setView(startCenter, startZoom, { animate: false });
      await waitLeafletIdle(map, 800);
    }
  } catch (_) { /* ignore */ }
}

function enumerateFromLiveMap(map, { expandClusters }) {
  const results = [];
  const seen = new WeakSet();
  let idCounter = 0;

  const visit = (layer) => {
    if (!layer || seen.has(layer)) return;
    seen.add(layer);

    // markercluster groups: recurse into children without zooming.
    // getAllChildMarkers walks the internal tree.
    if (expandClusters && typeof layer.getAllChildMarkers === "function") {
      try {
        const kids = layer.getAllChildMarkers();
        for (const k of kids) visit(k);
        return;
      } catch (_) { /* fall through to generic eachLayer */ }
    }

    // LayerGroup / FeatureGroup: recurse.
    if (typeof layer.eachLayer === "function") {
      layer.eachLayer(visit);
      return;
    }

    // Actual marker: has getLatLng().
    if (typeof layer.getLatLng === "function") {
      const ll = layer.getLatLng();
      if (ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
        results.push({
          id: `leaflet-${idCounter++}`,
          lat: ll.lat,
          lng: ll.lng,
          raw: layer,
        });
      }
      return;
    }

    // GeoJSON layers, heatmaps, tile layers — ignore.
  };

  map.eachLayer(visit);
  return results;
}

function enumerateFromDOM(container) {
  // Last-ditch extractor: just grab .leaflet-marker-icon positions.
  // We cannot get lat/lng from the DOM (Leaflet uses CSS transforms in
  // pixel space). We can get the screen position, which is usable for
  // programmatic-click fallback but not for geographic output.
  //
  // In production, this branch should trigger a warning in the side panel:
  // "DOM-only Leaflet detection — geographic coordinates unavailable.
  //  Reload the page with the extension enabled to capture the map at
  //  construction time."
  const icons = Array.from(container.querySelectorAll(".leaflet-marker-icon"));
  return icons.map((el, i) => ({
    id: `leaflet-dom-${i}`,
    lat: null,
    lng: null,
    raw: { el, __domOnly: true },
  }));
}

function applySchemaHint(html, schemaHint) {
  // schemaHint shape (from the teach flow):
  //   { fields: [ { key: "name", selector: "h3" }, { key: "address", selector: ".addr" } ] }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = {};
  for (const f of schemaHint.fields || []) {
    const el = doc.querySelector(f.selector);
    if (el) out[f.key] = (el.textContent || "").trim();
  }
  return out;
}
