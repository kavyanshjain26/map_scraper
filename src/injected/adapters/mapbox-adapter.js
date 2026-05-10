// src/injected/adapters/mapbox-adapter.js
// Mapbox GL / MapLibre GL support. The page-world hook captures live map
// instances, HTML Marker instances, and addLayer calls. Enumeration reads HTML
// marker coordinates, GeoJSON source data, and clustered source leaves.

import { BaseAdapter } from "./base-adapter.js";
import { applySchemaFields } from "../../shared/schema-selectors.js";
import { recoverFromGlobals, recoverFromContainer } from "../recover.js";

const MAP_INSTANCES = (window.__MMS_MAPBOX_INSTANCES__ ||= []);
const MARKER_INSTANCES = (window.__MMS_MAPBOX_MARKER_INSTANCES__ ||= []);
const LAYER_CALLS = (window.__MMS_MAPBOX_LAYER_CALLS__ ||= []);

export function installMapboxHook() {
  if (window.__MMS_MAPBOX_HOOKED__) return;

  const tryHook = () => {
    const gl = window.mapboxgl || window.maplibregl;
    if (!gl || !gl.Map) return false;
    if (gl.Map.__mmsHooked) return true;

    const OriginalMap = gl.Map;
    function HookedMap(...args) {
      const instance = new OriginalMap(...args);
      hookMapInstance(instance);
      try { MAP_INSTANCES.push(instance); } catch (_) {}
      return instance;
    }
    HookedMap.prototype = OriginalMap.prototype;
    Object.setPrototypeOf(HookedMap, OriginalMap);
    HookedMap.__mmsHooked = true;

    if (gl.Marker && !gl.Marker.__mmsHooked) {
      const OriginalMarker = gl.Marker;
      function HookedMarker(...args) {
        const marker = new OriginalMarker(...args);
        try { MARKER_INSTANCES.push(marker); } catch (_) {}
        return marker;
      }
      HookedMarker.prototype = OriginalMarker.prototype;
      Object.setPrototypeOf(HookedMarker, OriginalMarker);
      HookedMarker.__mmsHooked = true;
      if (window.mapboxgl) window.mapboxgl.Marker = HookedMarker;
      if (window.maplibregl) window.maplibregl.Marker = HookedMarker;
    }

    if (window.mapboxgl) window.mapboxgl.Map = HookedMap;
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

function hookMapInstance(map) {
  if (!map || map.__mmsAddLayerHooked || typeof map.addLayer !== "function") return;
  const originalAddLayer = map.addLayer;
  map.addLayer = function (layer, beforeId) {
    try { LAYER_CALLS.push({ map: this, layer }); } catch (_) {}
    return originalAddLayer.call(this, layer, beforeId);
  };
  map.__mmsAddLayerHooked = true;
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
        instances: hooked.map((map) => ({ kind: "live", map })),
      };
    }

    // Hook missed construction. Try to dig the live Map out of window.* /
    // the .mapboxgl-map container's internal state. Sites stash their map
    // on window.map, window.app.map, etc. quite often.
    const containerEls = Array.from(domHits);
    const recovered = recoverMapboxMaps(containerEls);
    if (recovered.length > 0) {
      for (const m of recovered) {
        if (!MAP_INSTANCES.includes(m)) {
          MAP_INSTANCES.push(m);
          try { hookMapInstance(m); } catch (_) {}
        }
      }
      return {
        confidence: 0.85,
        reason: `recovered ${recovered.length} Mapbox/MapLibre Map(s) from page state`,
        instances: recovered.map((map) => ({ kind: "live", map })),
      };
    }

    return {
      confidence: 0.5,
      reason: `DOM signals only (${domHits.length}) — reload page for full extraction`,
      instances: containerEls.map((el) => ({ kind: "dom-only", el })),
    };
  }

  get rendersToCanvas() { return true; }

  async enumerateMarkers(instance, { expandClusters = true, mode = "library", deepScan = false } = {}) {
    if (instance.kind !== "live") {
      throw new Error("Mapbox DOM-only enumeration not supported - reload with the extension active");
    }

    const map = instance.map;
    if (deepScan) await deepScanMapbox(map);

    const out = [];
    const seen = new Set();
    let id = 0;
    const push = (lat, lng, raw) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: `mapbox-${id++}`, lat, lng, raw });
    };

    for (const marker of MARKER_INSTANCES) {
      if (marker._map !== map) continue;
      const ll = marker.getLngLat?.();
      if (!ll) continue;
      push(ll.lat, ll.lng, { kind: "html-marker", marker });
    }

    if (!map.isStyleLoaded?.()) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        map.once?.("styledata", () => { clearTimeout(timer); resolve(); });
      });
    }

    const style = map.getStyle?.();
    const sources = style?.sources || {};
    for (const [sourceId, sourceDef] of Object.entries(sources)) {
      if (sourceDef.type !== "geojson") continue;
      const source = map.getSource(sourceId);
      if (!source) continue;

      const features = mode === "pan"
        ? await readGeoJsonFeaturesAcrossPanGrid(map, sourceId, source, sourceDef, { expandClusters })
        : await readGeoJsonFeatures(map, sourceId, source, sourceDef, { expandClusters, queryTiles: true });

      for (const feature of features) {
        const point = featureToPoint(feature);
        if (!point) continue;
        push(point.lat, point.lng, {
          kind: "geojson-feature",
          sourceId,
          properties: feature.properties || {},
        });
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
        if (schemaHint) Object.assign(out, applySchema(el, schemaHint));
      }
      const popup = raw.marker.getPopup?.();
      if (popup) {
        const html = popup.getElement?.()?.innerHTML || popup._content || null;
        if (html) out.popup_html = typeof html === "string" ? html : html.outerHTML;
      }
    }

    if (raw?.kind === "geojson-feature") {
      for (const [key, value] of Object.entries(raw.properties)) {
        if (value === null) continue;
        const type = typeof value;
        if (type === "string" || type === "number" || type === "boolean") out[key] = value;
        else out[key] = JSON.stringify(value);
      }
    }

    return out;
  }
}

function applySchema(rootEl, schemaHint) {
  return applySchemaFields(rootEl, schemaHint);
}

// Shape-check for a live Mapbox-GL / MapLibre-GL Map instance.
function isMapboxMap(o) {
  if (!o || typeof o !== "object") return false;
  const gl = window.mapboxgl || window.maplibregl;
  if (gl?.Map) {
    try { if (o instanceof gl.Map) return true; } catch (_) { /* fall through */ }
  }
  return typeof o.getStyle === "function"
      && typeof o.queryRenderedFeatures === "function"
      && typeof o.getCenter === "function"
      && typeof o.getZoom === "function";
}

function recoverMapboxMaps(containers) {
  const found = new Set();
  for (const m of recoverFromGlobals(isMapboxMap)) found.add(m);
  for (const el of containers) {
    const m = recoverFromContainer(el, isMapboxMap);
    if (m) found.add(m);
  }
  // Filter to maps whose container is present on this page.
  const containerSet = new Set(containers);
  return Array.from(found).filter((m) => {
    try {
      const c = m.getContainer?.();
      return !c || containerSet.has(c);
    } catch { return true; }
  });
}

async function readGeoJsonFeatures(map, sourceId, source, sourceDef, { expandClusters = true, queryTiles = true } = {}) {
  const out = [];
  let data = source?._data ?? sourceDef?.data ?? null;

  if (typeof data === "string") {
    try {
      const res = await fetch(data, { credentials: "same-origin" });
      if (res.ok) data = await res.json();
    } catch (_) {
      data = null;
    }
  }

  if (sourceDef?.cluster && expandClusters && typeof source.getClusterLeaves === "function") {
    out.push(...await collectMapboxClusterLeaves(map, source, sourceId));
  }

  if (data?.type === "FeatureCollection" && Array.isArray(data.features)) {
    for (const feature of data.features) {
      if (!feature?.properties?.cluster) out.push(feature);
    }
    return out;
  }

  if (!queryTiles) return out;
  const queryOptions = {};
  if (sourceDef?.sourceLayer) queryOptions.sourceLayer = sourceDef.sourceLayer;

  let queried = [];
  try {
    queried = map.querySourceFeatures?.(
      sourceId,
      Object.keys(queryOptions).length ? queryOptions : undefined,
    ) || [];
  } catch (_) {
    queried = [];
  }

  for (const feature of queried) {
    if (feature?.properties?.cluster && expandClusters && typeof source.getClusterLeaves === "function") {
      const leaves = await getClusterLeavesPaged(source, feature.properties.cluster_id, feature.properties.point_count);
      out.push(...leaves);
    } else if (!feature?.properties?.cluster) {
      out.push(feature);
    }
  }
  return out;
}

async function collectMapboxClusterLeaves(map, source, sourceId) {
  const out = [];
  const layers = (map.getStyle?.()?.layers || []).filter((layer) => layer.source === sourceId);
  if (!layers.length) return out;

  const seenIds = new Set();
  const clusters = [];
  for (const layer of layers) {
    let features = [];
    const options = layer["source-layer"] ? { sourceLayer: layer["source-layer"] } : undefined;
    try { features = map.querySourceFeatures?.(sourceId, options) || []; } catch (_) { continue; }
    for (const feature of features) {
      const clusterId = feature.properties?.cluster_id;
      if (clusterId == null || seenIds.has(clusterId)) continue;
      seenIds.add(clusterId);
      clusters.push({ id: clusterId, count: feature.properties.point_count || 1000 });
    }
  }

  for (const cluster of clusters) {
    out.push(...await getClusterLeavesPaged(source, cluster.id, cluster.count));
  }
  return out;
}

async function getClusterLeavesPaged(source, clusterId, total = 50000) {
  const out = [];
  let offset = 0;
  const limit = 500;
  while (offset < total) {
    const leaves = await getClusterLeaves(source, clusterId, limit, offset);
    if (leaves.length === 0) break;
    out.push(...leaves);
    offset += leaves.length;
    if (leaves.length < limit) break;
  }
  return out;
}

function getClusterLeaves(source, clusterId, limit, offset) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (items) => {
      if (settled) return;
      settled = true;
      resolve(Array.isArray(items) ? items : []);
    };

    try {
      const maybePromise = source.getClusterLeaves(clusterId, limit, offset, (err, leaves) => {
        if (err) finish([]);
        else finish(leaves);
      });
      if (maybePromise?.then) {
        maybePromise.then(finish, () => finish([]));
      } else {
        setTimeout(() => finish([]), 2000);
      }
    } catch (_) {
      finish([]);
    }
  });
}

function featureToPoint(feature) {
  if (feature?.geometry?.type !== "Point") return null;
  const coords = feature.geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function readGeoJsonFeaturesAcrossPanGrid(map, sourceId, source, sourceDef, opts) {
  const out = [];
  const seen = new Set();
  const add = (features) => {
    for (const feature of features) {
      const key = featureKey(feature);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(feature);
    }
  };

  add(await readGeoJsonFeatures(map, sourceId, source, sourceDef, { ...opts, queryTiles: true }));

  const original = readMapView(map);
  const centers = panGridCenters(map);
  for (const center of centers) {
    moveMap(map, center, original?.zoom);
    await waitForMapIdle(map, 700);
    add(await readGeoJsonFeatures(map, sourceId, source, sourceDef, { ...opts, queryTiles: true }));
  }

  if (original) {
    moveMap(map, original.center, original.zoom);
    await waitForMapIdle(map, 400);
  }
  return out;
}

function readMapView(map) {
  const center = map.getCenter?.();
  const zoom = map.getZoom?.();
  if (!center) return null;
  return {
    center: [Number(center.lng), Number(center.lat)],
    zoom: Number.isFinite(zoom) ? zoom : undefined,
  };
}

function moveMap(map, center, zoom) {
  try {
    if (typeof map.jumpTo === "function") map.jumpTo({ center, zoom });
    else if (typeof map.panTo === "function") map.panTo(center, { duration: 0 });
  } catch (_) {}
}

function panGridCenters(map) {
  const bounds = map.getMaxBounds?.() || map.getBounds?.();
  if (!bounds) return [];
  let west = Number(bounds.getWest?.());
  let east = Number(bounds.getEast?.());
  let south = Number(bounds.getSouth?.());
  let north = Number(bounds.getNorth?.());

  if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(north)) {
    return [];
  }

  if (!map.getMaxBounds?.()) {
    const width = Math.max(0.01, east - west);
    const height = Math.max(0.01, north - south);
    west -= width;
    east += width;
    south -= height;
    north += height;
  }

  west = clamp(west, -180, 180);
  east = clamp(east, -180, 180);
  south = clamp(south, -85, 85);
  north = clamp(north, -85, 85);

  const centers = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      centers.push([
        west + ((col + 0.5) / 3) * (east - west),
        south + ((row + 0.5) / 3) * (north - south),
      ]);
    }
  }
  return centers;
}

async function deepScanMapbox(map) {
  const original = readMapView(map);
  try {
    map.fitBounds?.([[-170, -55], [170, 60]], { animate: false, duration: 0 });
    await waitForMapIdle(map, 2000);
  } catch (_) {}

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const lat = -55 + (115 / 3) * (row + 0.5);
      const lng = -170 + (340 / 3) * (col + 0.5);
      moveMap(map, [lng, lat], 5);
      await waitForMapIdle(map, 2000);
    }
  }

  if (original) {
    moveMap(map, original.center, original.zoom);
    await waitForMapIdle(map, 800);
  }
}

function waitForMapIdle(map, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    try {
      map.once?.("idle", () => {
        clearTimeout(timer);
        resolve();
      });
    } catch (_) {}
  });
}

function featureKey(feature) {
  const id = feature?.id ?? feature?.properties?.id ?? feature?.properties?.storeId;
  if (id !== undefined) return `id:${id}`;
  const point = featureToPoint(feature);
  if (point) return `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
  return JSON.stringify(feature?.properties || {});
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
