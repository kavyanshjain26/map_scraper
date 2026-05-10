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
import { applySchemaFields } from "../../shared/schema-selectors.js";

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

  async enumerateMarkers(instance, { expandClusters = true } = {}) {
    if (instance.kind === "live") {
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

function enumerateFromLiveMap(map, { expandClusters }) {
  const results = [];
  const seen = new WeakSet();
  let idCounter = 0;
  const L = window.L;

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

    // Actual marker: prefer Leaflet's class signal when available, then
    // fall back to the getLatLng surface used by custom marker-like layers.
    const isMarker = L?.Marker ? layer instanceof L.Marker : typeof layer.getLatLng === "function";
    if (isMarker && typeof layer.getLatLng === "function") {
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

  if (map._layers && typeof map._layers === "object") {
    Object.values(map._layers).forEach(visit);
  } else {
    map.eachLayer(visit);
  }
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
  return applySchemaFields(doc, schemaHint);
}
