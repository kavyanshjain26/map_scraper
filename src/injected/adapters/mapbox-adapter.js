// src/injected/adapters/mapbox-adapter.js
// Mapbox GL / MapLibre GL. Markers come in two flavors on real sites:
//
//   (1) HTML markers — new mapboxgl.Marker().setLngLat(...).addTo(map).
//       Each Marker instance is a wrapper around a DOM element. We hook
//       the Marker constructor to build a registry, then filter by
//       ._map === ourMap to get the markers on a specific map.
//
//   (2) Symbol-layer markers driven by a GeoJSON source. These are
//       NOT in the DOM — they're rendered on the WebGL canvas. BUT:
//       if the source is a loaded GeoJSON (not vector tiles), the
//       raw features live in map.getSource(id)._data. Clustering is
//       purely a display concern — the underlying _data still has
//       every feature. So we read _data directly and skip the
//       getClusterLeaves ceremony.
//
//       If the source's _data is a URL (not inline GeoJSON), we fetch
//       it. If it's vector tiles, we can only see the current
//       viewport via queryRenderedFeatures — that's a pan/zoom job we
//       leave to a future "aggressive" mode.

import { BaseAdapter } from "./base-adapter.js";

const MAP_INSTANCES    = (window.__MMS_MAPBOX_INSTANCES__        ||= []);
const MARKER_INSTANCES = (window.__MMS_MAPBOX_MARKER_INSTANCES__ ||= []);

export function installMapboxHook() {
  if (window.__MMS_MAPBOX_HOOKED__) return;

  const tryHook = () => {
    const gl = window.mapboxgl || window.maplibregl;
    if (!gl || !gl.Map) return false;
    if (gl.Map.__mmsHooked) return true;

    // --- Hook Map ---
    const OriginalMap = gl.Map;
    function HookedMap(...args) {
      const instance = new OriginalMap(...args);
      try { MAP_INSTANCES.push(instance); } catch (_) {}
      return instance;
    }
    HookedMap.prototype = OriginalMap.prototype;
    Object.setPrototypeOf(HookedMap, OriginalMap);
    HookedMap.__mmsHooked = true;

    // --- Hook Marker (also accumulated — filtered by ._map later) ---
    if (gl.Marker && !gl.Marker.__mmsHooked) {
      const OriginalMarker = gl.Marker;
      function HookedMarker(...args) {
        const m = new OriginalMarker(...args);
        try { MARKER_INSTANCES.push(m); } catch (_) {}
        return m;
      }
      HookedMarker.prototype = OriginalMarker.prototype;
      Object.setPrototypeOf(HookedMarker, OriginalMarker);
      HookedMarker.__mmsHooked = true;
      if (window.mapboxgl)  window.mapboxgl.Marker  = HookedMarker;
      if (window.maplibregl) window.maplibregl.Marker = HookedMarker;
    }

    if (window.mapboxgl)  window.mapboxgl.Map  = HookedMap;
    if (window.maplibregl) window.maplibregl.Map = HookedMap;
    window.__MMS_MAPBOX_HOOKED__ = true;
    return true;
  };

  if (tryHook()) return;
  let tries = 0;
  const timer = setInterval(() => {
    if (tryHook() || ++tries > 50) clearInterval(timer);
  }, 100);
}

export class MapboxAdapter extends BaseAdapter {
  static get name() { return "Mapbox GL"; }

  async detect() {
    const hooked = MAP_INSTANCES.slice();
    const domHits = document.querySelectorAll(".mapboxgl-map, .maplibregl-map");
    const hasGlobal = !!(window.mapboxgl || window.maplibregl);

    if (hooked.length === 0 && domHits.length === 0 && !hasGlobal) {
      return { confidence: 0, reason: "no mapbox/maplibre", instances: [] };
    }
    if (hooked.length > 0) {
      return {
        confidence: 0.9,
        reason: `hooked ${hooked.length} Map instance(s)`,
        instances: hooked.map(m => ({ kind: "live", map: m })),
      };
    }
    return {
      confidence: 0.5,
      reason: `DOM signals only (${domHits.length})`,
      instances: Array.from(domHits).map(el => ({ kind: "dom-only", el })),
    };
  }

  get rendersToCanvas() { return true; }

  async enumerateMarkers(instance, { expandClusters = true, deepScan = false } = {}) {
    if (instance.kind !== "live") {
      throw new Error("Mapbox DOM-only enumeration not supported — reload with the extension active");
    }
    const map = instance.map;

    if (deepScan) await deepScanMapbox(map);

    const out = [];
    const seen = new Set();
    let id = 0;

    const push = (lat, lng, raw) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const k = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ id: `mapbox-${id++}`, lat, lng, raw });
    };

    // --- (1) HTML markers via our Marker registry ---
    for (const m of MARKER_INSTANCES) {
      if (m._map !== map) continue;
      const ll = m.getLngLat?.();
      if (!ll) continue;
      push(ll.lat, ll.lng, { kind: "html-marker", marker: m });
    }

    // --- (2) GeoJSON-source features ---
    if (!map.isStyleLoaded?.()) {
      await new Promise((res) => {
        const t = setTimeout(res, 2000);
        map.once?.("styledata", () => { clearTimeout(t); res(); });
      });
    }

    const style = map.getStyle?.();
    const sources = style?.sources || {};
    for (const [srcId, srcDef] of Object.entries(sources)) {
      if (srcDef.type !== "geojson") continue;

      const src = map.getSource(srcId);
      if (!src) continue;

      let data = src._data;
      if (typeof data === "string") {
        try {
          const res = await fetch(data, { credentials: "same-origin" });
          if (!res.ok) continue;
          data = await res.json();
        } catch (_) { continue; }
      }

      // Source has clustering enabled. Walk the active clusters and ask
      // mapbox-gl for the leaves — handles dynamic data better than reading
      // _data, and works even when the source was built incrementally.
      if (srcDef.cluster && expandClusters && typeof src.getClusterLeaves === "function") {
        const leaves = await collectMapboxClusterLeaves(map, src, srcId);
        for (const feat of leaves) {
          if (feat.geometry?.type !== "Point") continue;
          const [lng, lat] = feat.geometry.coordinates;
          push(lat, lng, {
            kind: "geojson-feature",
            sourceId: srcId,
            properties: feat.properties || {},
          });
        }
      }

      if (data && data.type === "FeatureCollection" && Array.isArray(data.features)) {
        for (const feat of data.features) {
          if (feat.geometry?.type !== "Point") continue;
          if (feat.properties?.cluster) continue;
          const [lng, lat] = feat.geometry.coordinates;
          push(lat, lng, {
            kind: "geojson-feature",
            sourceId: srcId,
            properties: feat.properties || {},
          });
        }
      }
    }

    return out;
  }

  async extractMarkerData(record, schemaHint = null) {
    const { lat, lng, raw } = record;
    const out = { lat, lng };

    if (raw?.kind === "html-marker") {
      const el = raw.marker.getElement?.();
      if (el) {
        const text = (el.textContent || "").trim();
        if (text) out.text = text;
        // The element may contain child structure usable with schemaHint.
        if (schemaHint) Object.assign(out, applySchema(el, schemaHint));
      }
      const popup = raw.marker.getPopup?.();
      if (popup) {
        const html = popup.getElement?.()?.innerHTML || popup._content || null;
        if (html) out.popup_html = typeof html === "string" ? html : html.outerHTML;
      }
    }

    if (raw?.kind === "geojson-feature") {
      // GeoJSON properties are already structured — copy them flat.
      for (const [k, v] of Object.entries(raw.properties)) {
        if (v === null) continue;
        const t = typeof v;
        if (t === "string" || t === "number" || t === "boolean") out[k] = v;
        else out[k] = JSON.stringify(v);
      }
    }

    return out;
  }
}

// Walk every cluster in the source and pull its leaves out via the source's
// own getClusterLeaves API. We page through 500-leaf chunks for large
// clusters. Cheaper than zooming the map for each cluster.
async function collectMapboxClusterLeaves(map, src, srcId) {
  const out = [];
  const layers = (map.getStyle?.()?.layers || []).filter(l => l.source === srcId);
  if (!layers.length) return out;

  // Find clusters currently rendered. Iterate until we've seen the full set.
  // We zoom to the source's bounds first so clusters cover the whole dataset.
  const seenIds = new Set();
  const clusters = [];
  for (const layer of layers) {
    let feats = [];
    try { feats = map.querySourceFeatures(srcId, { sourceLayer: layer["source-layer"] }); }
    catch (_) { continue; }
    for (const f of feats) {
      const id = f.properties?.cluster_id;
      if (id != null && !seenIds.has(id)) {
        seenIds.add(id);
        clusters.push({ id, count: f.properties.point_count || 1000 });
      }
    }
  }

  for (const c of clusters) {
    let offset = 0;
    while (offset < c.count) {
      const leaves = await new Promise((resolve) => {
        try {
          src.getClusterLeaves(c.id, 500, offset, (err, feats) => {
            if (err) resolve([]);
            else resolve(feats || []);
          });
        } catch (_) { resolve([]); }
      });
      if (leaves.length === 0) break;
      out.push(...leaves);
      offset += leaves.length;
      if (leaves.length < 500) break;
    }
  }
  return out;
}

function waitMapboxIdle(map, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    map.once?.("idle", () => { clearTimeout(t); resolve(); });
  });
}

// Pan-and-zoom sweep for Mapbox/MapLibre. Same goal as Leaflet's: trigger
// any viewport-bound data loaders (vector tiles, AJAX layers).
async function deepScanMapbox(map) {
  const startCenter = map.getCenter?.();
  const startZoom = map.getZoom?.();

  let south = -55, west = -170, north = 60, east = 170;
  try {
    const b = map.getBounds?.();
    if (b) {
      south = b.getSouth(); west = b.getWest();
      north = b.getNorth(); east = b.getEast();
    }
  } catch (_) { /* ignore */ }

  // Try the world first to ensure broad data is requested.
  try {
    map.fitBounds([[-170, -55], [170, 60]], { animate: false, duration: 0 });
    await waitMapboxIdle(map);
  } catch (_) { /* ignore */ }

  // 3x3 grid sweep at moderate zoom.
  const grid = 3;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const lat = -55 + (115 / grid) * (i + 0.5);
      const lng = -170 + (340 / grid) * (j + 0.5);
      try {
        map.jumpTo?.({ center: [lng, lat], zoom: 5 });
        await waitMapboxIdle(map);
      } catch (_) { /* ignore */ }
    }
  }

  // Restore.
  try {
    if (startCenter && typeof startZoom === "number") {
      map.jumpTo?.({ center: startCenter, zoom: startZoom });
      await waitMapboxIdle(map, 800);
    }
  } catch (_) { /* ignore */ }
}

function applySchema(rootEl, schemaHint) {
  const out = {};
  for (const f of schemaHint.fields || []) {
    const el = rootEl.querySelector(f.selector);
    if (el) out[f.key] = (el.textContent || "").trim();
  }
  return out;
}
