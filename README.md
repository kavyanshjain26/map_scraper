# Map Marker Scraper (v1.0)

A Chrome (MV3) extension that scrapes markers / pins from maps on any
website. Supports Leaflet, Mapbox GL / MapLibre, Google Maps, and
OpenLayers via library-specific adapters; falls back to a visual marker
picker for DOM-rendered maps; and a network-fetch mode for WebGL/vector
tile maps or sites that expose a JSON endpoint.

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**, pick this folder
4. Pin the extension; click its icon to open the side panel

## Use it

The side panel walks you through four steps.

**1. Detect maps.** Click "Detect". Every adapter runs its detection and
reports confidence. If one of Leaflet/Mapbox/Google/OL is there, you'll
see it with high confidence and an instance count. If not, all of them
return 0 and you'll fall through to pick mode or network mode.

**2. Teach** (optional but recommended). Click "Start teach mode", then
click a real pin on the map. Within 2 seconds we capture the popup
HTML and any network requests that fired. The popup feeds schema
inference (Step 3); the network requests feed Network mode (Step 4).

**2b. Pick mode** (for DOM-rendered maps). If detection found nothing
and the pins are real DOM elements, click "Start pick mode" and click
one of the pins on the page. We derive a selector that matches every
similar element on the page and enable the generic DOM adapter.

**3. Schema.** Inferred fields appear as editable key/selector pairs.
You can rename keys, tweak selectors, delete fields, or add new ones.
Inferred fields are: name (first heading), phone (tel: link), email
(mailto: link), website (first external http link), address (regex on
street patterns), hours (regex on weekday + time).

**4. Enumerate.**

- **Library mode** (default): runs the detected adapter's
  enumeration. Expands clusters when possible. Applies the schema to
  each marker's popup content. Preview + CSV/JSON export.
- **Network mode**: fetches a URL, walks the JSON response, finds the
  largest array of `{lat, lng, ...}`-shaped objects, returns them.
  Click any captured request from Step 2 to pre-fill the URL.

**Save profile** remembers the adapter, mode, schema, and URL for the
site's origin. Revisit the site later — the panel loads the profile
automatically and you can skip straight to enumerate.

## Architecture

```
┌───────────────┐       chrome.runtime           ┌──────────────────────┐
│  side panel   │ ◄────────────────────────────► │   service worker     │
│  sidepanel.js │                                │  webRequest buffer   │
└───────┬───────┘                                └──────────┬───────────┘
        │ chrome.tabs.sendMessage                           │
        ▼                                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       TAB — isolated worlds                          │
│                                                                      │
│   content-script.js  (isolated)                                      │
│    teach / pick / forward / fetch-with-cookies                       │
│        │                                                             │
│        │ injects <script type="module">  +  window.postMessage       │
│        ▼                                                             │
│   page-script.js  (MAIN world — window.L, window.google, …)          │
│        │                                                             │
│        └── detector.js  ──►  adapters/*.js                           │
└─────────────────────────────────────────────────────────────────────┘
```

Two scripts per tab because content scripts live in an isolated JS
world and can't see the page's globals (`window.L`, `window.google`,
etc.), while page-world scripts can't call `chrome.*` APIs. The
content script bridges postMessage ↔ chrome.runtime and hosts pick /
teach modes (which need DOM event capture + highlight styling).

## The adapter pattern

Every map-library adapter extends `BaseAdapter` (in
`src/injected/adapters/base-adapter.js`) and implements:

- `detect()` — "is this library in use?" returns confidence + instance
  handles. Never mutates the page.
- `enumerateMarkers(instance, opts)` — returns a list of
  `{ id, lat, lng, raw }` for every marker, including markers hidden
  inside clusters.
- `extractMarkerData(marker, schemaHint)` — pulls serializable fields
  off one marker. Takes the optional `schemaHint` from the teach flow.

Constructor hooks (installed at `document_start`) capture map +
marker instances as they're created:

| Library     | Hooks                                                        |
| ----------- | ------------------------------------------------------------ |
| Leaflet     | `L.Map.prototype.initialize`                                 |
| Mapbox GL   | `mapboxgl.Map`, `mapboxgl.Marker` (+ maplibregl aliases)     |
| Google Maps | `google.maps.Map`, `google.maps.Marker`, `AdvancedMarkerElement` |
| OpenLayers  | `ol.Map` (only on sites with a window.ol global)             |

## Limitations

- **Bundled OpenLayers apps** without a `window.ol` global can't be
  hooked. Detection shows "bundled OL — can't hook". Fall back to
  network mode if there's a JSON endpoint, or pick mode if the pins
  are in the DOM.
- **WebGL vector-tile maps** render markers on canvas — no DOM, no
  data array. Library-mode enumeration works for GeoJSON sources
  (Mapbox reads `_data`) but not for vector-tile sources. Network mode
  is the workaround.
- **Google Places**: Google's Terms of Service forbid scraping the
  Places / Maps database. Scraping a third-party site that happens to
  display its own data on Google Maps (e.g. a store locator) is
  usually fine; check the target site's ToS.
- **Hook misses**: if the site constructs its map before our content
  script runs (rare — we run at document_start — but possible on the
  very first page load when the extension is freshly installed), the
  adapter reports "hook missed construction" and DOM-only fallback
  kicks in with no lat/lng. Reload the page to fix.
- **Rate limits**: pick-mode's DOM adapter clicks each pin with a
  200ms delay. A page with 500 pins takes ~100 seconds. For Network
  mode there's no per-marker cost — one fetch for the whole set.

## File map

| File                                           | Role                                   |
| ---------------------------------------------- | -------------------------------------- |
| `manifest.json`                                | MV3 config                             |
| `src/background/service-worker.js`             | Sidepanel open, webRequest buffer      |
| `src/content/content-script.js`                | Isolated-world bridge + teach + pick + fetch |
| `src/content/overlay.css`                      | Pick-mode highlight style              |
| `src/injected/page-script.js`                  | MAIN-world entry, progress emit        |
| `src/injected/detector.js`                     | Runs all adapters, picks winner        |
| `src/injected/adapters/base-adapter.js`        | Adapter interface                      |
| `src/injected/adapters/leaflet-adapter.js`     | Leaflet (markercluster included)       |
| `src/injected/adapters/mapbox-adapter.js`      | Mapbox GL + MapLibre (HTML + GeoJSON)  |
| `src/injected/adapters/google-maps-adapter.js` | Google Maps (legacy + Advanced)        |
| `src/injected/adapters/openlayers-adapter.js`  | OpenLayers (layer/feature walk)        |
| `src/injected/adapters/dom-adapter.js`         | Generic DOM click-through              |
| `src/sidepanel/*`                              | User-facing UI                         |
| `src/shared/messages.js`                       | Message-type constants                 |
| `src/shared/schema.js`                         | Schema-inference heuristics            |
| `src/shared/profiles.js`                       | Per-site profile storage               |
| `src/shared/network-fetch.js`                  | Network mode: fetch + JSON auto-walk   |
| `src/shared/export.js`                         | CSV helpers                            |

## Publishing to the Chrome Web Store

Before you publish, change `"<all_urls>"` in `host_permissions` to
`"optional_host_permissions"` and request per-site access via
`chrome.permissions.request()` when the user clicks Detect. Review gets
much easier and it's safer for users.

## ToS reminder

Scraping markers off a site you don't own may violate that site's Terms
of Service. Use this on sites where the data is offered for this kind of
use (public OSM with attribution, your own store locator, research
exempted by ToS, etc.). Respect robots.txt and rate limits.
