// src/injected/adapters/base-adapter.js
// Runs in the page's MAIN world (has access to window.L, window.google, etc.).
//
// Every map-library adapter extends this. The detector calls detect() on all
// of them, picks the winner by confidence, and then drives it to enumerate
// markers.
//
// DESIGN NOTES
// ------------
// - Adapters MUST be side-effect-free at import time. All library access
//   happens inside methods, because the library may load after we do.
// - enumerateMarkers() is async and may take a while. It should yield
//   progress via the onProgress callback.
// - Clusters: if the library exposes a way to read cluster children without
//   zooming, prefer that. Fallback is programmatic pan/zoom, which is slow
//   and noisy and belongs in a separate "aggressive" mode.
// - Never throw from detect() — return { confidence: 0, reason: "..." }.
//   A thrown error should only happen in enumerateMarkers() when the
//   adapter is actually driving the page.

export class BaseAdapter {
  /** Human-readable name, e.g. "Leaflet". */
  static get name() { return "Base"; }

  /**
   * Cheap, synchronous-ish check: "is this library present on the page and
   * in use?" Return value:
   *   {
   *     confidence: 0..1,      // 0 = not present, 1 = clearly the map
   *     reason: string,        // why we think so (for debugging)
   *     instances: Array<any>, // library-specific map instance handles
   *   }
   * Must not mutate the page. Must not throw.
   */
  async detect() {
    return { confidence: 0, reason: "base adapter never matches", instances: [] };
  }

  /**
   * Given a map instance handle from detect(), return all markers the
   * library currently knows about — including markers hidden inside
   * clusters, if the library lets us read them without interaction.
   *
   * Returns: Array of { id, lat, lng, raw } where `raw` is the native
   * marker object (we don't serialize it here; extractMarkerData does).
   */
  async enumerateMarkers(instance, { expandClusters = true } = {}) {
    throw new Error("enumerateMarkers() not implemented");
  }

  /**
   * Pull structured data out of a single marker. This is where per-site
   * schema inference plugs in — `schemaHint` comes from the teach flow
   * ("name is the <h3>, address is the <p.addr>" etc.) and tells us how
   * to read the popup content. Without a hint, we return whatever we
   * can get cheaply (lat/lng + any title/label the library exposes).
   *
   * Returns: plain object, JSON-serializable.
   */
  async extractMarkerData(marker, schemaHint = null) {
    return {
      lat: marker.lat,
      lng: marker.lng,
    };
  }

  /**
   * Optional: for libraries that render markers to canvas/WebGL and
   * therefore can't be enumerated via DOM, this returns true so the
   * pipeline falls back to network interception instead of DOM scraping.
   */
  get rendersToCanvas() { return false; }
}
