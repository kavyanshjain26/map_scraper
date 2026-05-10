# Map Marker Scraper (v1.4.0)

A Chrome MV3 extension that extracts map pins from store locators and other
map-heavy websites. It prefers structured data first, then map-library APIs,
and uses DOM clicking only as the last fallback.

Supported library paths:

- Leaflet, including `Leaflet.markercluster`
- Google Maps JavaScript API v3, including `AdvancedMarkerElement`
- Mapbox GL and MapLibre GL, including GeoJSON sources and clusters
- OpenLayers vector layers
- deck.gl layer data arrays
- Generic DOM markers through visual pick/teach mode

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose this folder.
4. Pin the extension and click it to open the side panel.

## Extraction Order

The side panel now runs a data-source-first strategy:

1. **Page data source**: the page-world script scans safe `window.*` values for
   arrays or GeoJSON with marker-shaped coordinates.
2. **Cached fetch/XHR response**: the page-world script clones likely JSON or
   GeoJSON fetch/XHR responses and scans the cached bodies.
3. **Network endpoint replay**: the service worker's teach-window request list
   is ranked for likely location APIs and replayed with page cookies.
4. **Library mode**: adapters enumerate native map objects without DOM scraping.
5. **Pan mode**: Mapbox/MapLibre can sample a small map grid for viewport-culled
   GeoJSON/query-source features, then restore the original view.
6. **List mode**: repeated sidebar/card rows are extracted when available.
7. **DOM zoom/click mode**: cluster-like DOM markers are expanded recursively,
   then pins are clicked and popups are scored.

## Teach Mode

Teach mode captures more than a single "largest mutation" now. For each sample
click it records:

- the clicked marker selector, scored with map-specific positive/negative signs;
- the full mutation sequence, including child, attribute, and text changes;
- all popup candidates, scored by visibility, contact/address patterns, and
  whether the element was empty before the click;
- the best popup HTML for schema inference.

Clicking several pins lets the side panel merge inferred fields across samples,
which makes popup templates much less brittle.

## Library Hooks

Constructor hooks are installed at `document_start` in the page world so they can
see `window.L`, `window.google`, `window.mapboxgl`, and similar globals before
the site's bundle creates the map.

| Library | Hook / enumeration path |
| --- | --- |
| Leaflet | Hook `L.Map`, walk `map._layers`, filter `L.Marker`, expand `getAllChildMarkers()` |
| Google Maps | Hook `google.maps.Map`, `google.maps.Marker`, and `google.maps.marker.AdvancedMarkerElement` |
| Mapbox GL / MapLibre | Hook `Map`, `Marker`, and `addLayer`; read GeoJSON sources and `getClusterLeaves()` |
| OpenLayers | Hook `ol.Map`, walk vector layers and cluster feature leaves |
| deck.gl | Hook `Deck`, capture layer props, read `props.data` and `getPosition` |

## Project Layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 config |
| `src/background/service-worker.js` | Side panel open, message routing, teach-window request buffer |
| `src/content/content-script.js` | Isolated-world bridge, teach mode, picker, cookie-aware fetch |
| `src/content/capture-heuristics.js` | Marker selector and popup candidate scoring |
| `src/injected/page-script.js` | Page-world hooks, data-source scan, adapter command bridge |
| `src/injected/detector.js` | Adapter detection and hook installation |
| `src/injected/adapters/*.js` | Library and DOM adapters |
| `src/shared/network-fetch.js` | JSON/GeoJSON endpoint parsing and marker-array detection |
| `src/shared/schema-selectors.js` | Safe selector application |
| `src/sidepanel/*` | UI and extraction strategy |
| `tests/*` | Focused helper tests and syntax check |

## Development Checks

```bash
npm test
npm run check:syntax
```

## Limitations

- Bundled OpenLayers apps without a `window.ol` global cannot be hooked; use
  page data, network, or DOM fallback.
- Vector-tile-only Mapbox layers do not expose all source rows as GeoJSON.
  Network/data-source extraction is still the best path for those.
- Google Places data is governed by Google's terms. This tool is intended for
  extracting a site's own location data, not scraping Google's Places database.
- Hook misses can happen if a page builds the map before the extension is active.
  Reloading the page usually gives the document-start hooks a clean shot.

## Publishing Note

Before publishing, consider replacing broad `host_permissions` with optional
host permissions requested only when capture starts. The current implementation
keeps the request buffer scoped to active teach sessions, but optional host
permissions are easier for users and reviewers to reason about.
