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
import { applySchemaFields } from "../../shared/schema-selectors.js";

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
        try { MARKER_INSTANCES.push({ kind: "marker", marker: inst }); } catch (_) {}
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
        try { MARKER_INSTANCES.push({ kind: "advanced", marker: inst }); } catch (_) {}
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

  async enumerateMarkers(instance, { expandClusters = true } = {}) {
    if (instance.kind !== "live") {
      throw new Error("Google Maps DOM-only enumeration not supported — reload with the extension active");
    }
    const map = instance.map;
    const out = [];
    let id = 0;

    for (const rec of MARKER_INSTANCES) {
      const m = rec.marker;
      if (m.map !== map && m.getMap?.() !== map) continue;

      let lat, lng;
      if (rec.kind === "marker") {
        const pos = m.getPosition?.();
        if (!pos) continue;
        lat = typeof pos.lat === "function" ? pos.lat() : pos.lat;
        lng = typeof pos.lng === "function" ? pos.lng() : pos.lng;
      } else {
        // AdvancedMarkerElement: .position is LatLng | LatLngLiteral
        const p = m.position;
        if (!p) continue;
        lat = typeof p.lat === "function" ? p.lat() : p.lat;
        lng = typeof p.lng === "function" ? p.lng() : p.lng;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      out.push({
        id: `google-${rec.kind}-${id++}`,
        lat, lng,
        raw: rec,
      });
    }

    return out;
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
  return applySchemaFields(rootEl, schemaHint);
}
