// src/injected/adapters/openlayers-adapter.js
// OpenLayers (ol).
//
// Detection:
//   - window.ol is present when the site loads OL via a <script> tag.
//     Modern bundled apps have no global — those get DOM-only detection
//     with confidence 0.5 and a warning.
//   - DOM signal: .ol-viewport element.
//
// Hook strategy:
//   - We hook window.ol.Map when it's available so construction is
//     captured. Bundled apps can't be hooked this way — we document the
//     limitation in the README.
//
// Enumeration:
//   - Walk map.getLayers() recursively (layer groups contain layers).
//   - For each layer that has getSource() returning a Vector source,
//     call getSource().getFeatures() — returns every loaded feature.
//   - Each Feature has a geometry; Point geometry gives us lat/lng via
//     the map's projection (default EPSG:3857, convert to EPSG:4326).
//   - ol.Cluster layers wrap a source; cluster features have a
//     `features` property with the original leaves. Walk through.

import { BaseAdapter } from "./base-adapter.js";

const INSTANCES = (window.__MMS_OL_INSTANCES__ ||= []);

export function installOLHook() {
  if (window.__MMS_OL_HOOKED__) return;
  const tryHook = () => {
    const ol = window.ol;
    if (!ol?.Map) return false;
    if (ol.Map.__mmsHooked) return true;
    const Original = ol.Map;
    function Hooked(...args) {
      const inst = new Original(...args);
      try { INSTANCES.push(inst); } catch (_) {}
      return inst;
    }
    Hooked.prototype = Original.prototype;
    Object.setPrototypeOf(Hooked, Original);
    Hooked.__mmsHooked = true;
    ol.Map = Hooked;
    window.__MMS_OL_HOOKED__ = true;
    return true;
  };
  if (tryHook()) return;
  let tries = 0;
  const timer = setInterval(() => {
    if (tryHook() || ++tries > 50) clearInterval(timer);
  }, 100);
}

export class OpenLayersAdapter extends BaseAdapter {
  static get name() { return "OpenLayers"; }

  async detect() {
    const hooked = INSTANCES.slice();
    const viewports = document.querySelectorAll(".ol-viewport");

    if (hooked.length === 0 && viewports.length === 0) {
      return { confidence: 0, reason: "no .ol-viewport or ol global", instances: [] };
    }
    if (hooked.length > 0) {
      return {
        confidence: 0.9,
        reason: `hooked ${hooked.length} ol.Map instance(s)`,
        instances: hooked.map(m => ({ kind: "live", map: m })),
      };
    }
    return {
      confidence: 0.4,
      reason: `${viewports.length} .ol-viewport(s), bundled OL — can't hook`,
      instances: Array.from(viewports).map(el => ({ kind: "dom-only", el })),
    };
  }

  async enumerateMarkers(instance) {
    if (instance.kind !== "live") {
      throw new Error("OpenLayers bundled-build enumeration isn't supported — ol is not on window. Try network-fetch mode.");
    }
    const map = instance.map;
    const out = [];
    let id = 0;

    // Read destination projection so we can transform point coords to WGS84.
    const view = map.getView();
    const proj = view?.getProjection?.()?.getCode?.() || "EPSG:3857";

    const transform = (coord) => {
      if (proj === "EPSG:4326") return coord;   // already lon/lat
      const ol = window.ol;
      if (ol?.proj?.transform) return ol.proj.transform(coord, proj, "EPSG:4326");
      if (ol?.proj?.toLonLat)  return ol.proj.toLonLat(coord, proj);
      return null;   // no conversion available
    };

    const visitLayer = (layer) => {
      // LayerGroup: recurse.
      if (typeof layer.getLayers === "function") {
        layer.getLayers().forEach(visitLayer);
        return;
      }
      // Vector layer: has getSource returning a VectorSource.
      const src = layer.getSource?.();
      if (!src || typeof src.getFeatures !== "function") return;

      for (const feat of src.getFeatures()) {
        visitFeature(feat);
      }
    };

    const visitFeature = (feat) => {
      // Cluster features carry their leaves in a "features" property.
      const children = feat.get?.("features");
      if (Array.isArray(children) && children.length > 0) {
        for (const child of children) visitFeature(child);
        return;
      }
      const geom = feat.getGeometry?.();
      if (!geom || geom.getType?.() !== "Point") return;
      const lonLat = transform(geom.getCoordinates());
      if (!lonLat) return;
      const [lng, lat] = lonLat;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      out.push({
        id: `ol-${id++}`,
        lat, lng,
        raw: { kind: "ol-feature", feature: feat },
      });
    };

    map.getLayers().forEach(visitLayer);
    return out;
  }

  async extractMarkerData(record, schemaHint = null) {
    const { lat, lng, raw } = record;
    const out = { lat, lng };
    if (raw?.kind === "ol-feature") {
      const props = raw.feature.getProperties?.() || {};
      for (const [k, v] of Object.entries(props)) {
        if (k === "geometry" || k === "features") continue;
        if (v == null) continue;
        const t = typeof v;
        if (t === "string" || t === "number" || t === "boolean") out[k] = v;
        else out[k] = JSON.stringify(v);
      }
    }
    return out;
  }
}
