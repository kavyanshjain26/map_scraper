// src/injected/page-script.js
// MAIN-world entry point. Loaded by the content script appending a
// <script type="module" src="..."> to the page.

import { installAllHooks, detectAll } from "./detector.js";
import { extractMarkersFromJsonText, findMarkerArray, asCoords, validLatLng } from "../shared/network-fetch.js";

const TO_PAGE = "MMS_TO_PAGE";
const FROM_PAGE = "MMS_FROM_PAGE";
const BRIDGE_TOKEN = new URL(import.meta.url).searchParams.get("token") || "";

installAllHooks();
installNetworkResponseCacheHook();

window.addEventListener("message", async (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.source !== TO_PAGE || data.token !== BRIDGE_TOKEN) return;

  const { id, cmd, payload } = data;
  try {
    const result = await handle(cmd, payload);
    reply(id, { ok: true, result });
  } catch (e) {
    reply(id, { ok: false, error: e.message, stack: e.stack });
  }
});

function reply(id, body) {
  window.postMessage({ source: FROM_PAGE, token: BRIDGE_TOKEN, id, ...body }, "*");
}

// Light cache around detectAll so the (unavoidable) detect call inside
// ENUMERATE doesn't re-run every adapter when DETECT just finished.
// 1.5s TTL — long enough to cover a normal click → run cycle, short
// enough that newly-added markers aren't ignored on a long-running session.
let _detectCache = null;
let _detectCacheAt = 0;
async function cachedDetectAll() {
  if (_detectCache && Date.now() - _detectCacheAt < 1500) return _detectCache;
  _detectCache = await detectAll();
  _detectCacheAt = Date.now();
  return _detectCache;
}

async function handle(cmd, payload) {
  switch (cmd) {
    case "DETECT": {
      _detectCache = null;     // user-initiated detect always reruns
      const results = await cachedDetectAll();
      return results.map((result) => ({
        adapter: result.adapter,
        confidence: result.confidence,
        reason: result.reason,
        instanceCount: result.instances.length,
        instances: result.instances.map(serializeDetectInstance),
      }));
    }

    case "ENUMERATE": {
      const {
        adapterName,
        instanceIndex = 0,
        expandClusters = true,
        deepScan = false,
        schemaHint = null,
        mode = "library",
      } = payload || {};
      const results = await cachedDetectAll();
      const chosen = results.find((result) => result.adapter === adapterName);
      if (!chosen) throw new Error(`No detection for ${adapterName}`);
      const instance = chosen.instances[instanceIndex]
        || ((adapterName === "List (cards/rows)" && schemaHint?.listSelector)
          ? { kind: "list", selector: schemaHint.listSelector }
          : null);
      if (!instance) throw new Error(`No instance #${instanceIndex} for ${adapterName}`);

      const adapter = new chosen.ctor();
      const markers = await adapter.enumerateMarkers(instance, {
        expandClusters,
        deepScan,
        schemaHint,
        mode,
      });

      const step = Math.max(1, Math.floor(markers.length / 20));
      const extracted = [];
      let lastSent = 0;
      for (let i = 0; i < markers.length; i++) {
        extracted.push(await adapter.extractMarkerData(markers[i], schemaHint));
        if ((i + 1) % step === 0 || i === markers.length - 1) {
          postProgress(
            { done: i + 1, total: markers.length },
            extracted.slice(lastSent, i + 1),
          );
          lastSent = i + 1;
        }
      }
      return { count: extracted.length, markers: extracted };
    }

    case "FIND_DATA_SOURCES": {
      return findPageDataSources(payload?.limit || 5000);
    }

    default:
      throw new Error(`Unknown cmd: ${cmd}`);
  }
}

// Best-effort hunt for marker data already on the page. Designed to work
// without any user interaction: by the time the user opens the side panel
// most store-locator pages have hydrated their state into one of a small
// number of well-known places, and we want to find it before falling back
// to clicks or network replays.
//
// Scan order, fast-path first:
//   1. Well-known globals  (window.__NEXT_DATA__, __NUXT__, etc.)
//   2. JSON-LD <script type="application/ld+json">
//   3. Inline JSON scripts (Next.js, Apollo, Inertia, Algolia, generic)
//   4. data-* attributes containing JSON (Inertia data-page, livewire, etc.)
//   5. Cached fetch/XHR responses captured by our network hook
//   6. Generic window.* sweep (one level deep)
//
// Every step is bounded by a wall-clock budget so we never hang the page.
function findPageDataSources(limit = 5000) {
  const deadline = Date.now() + 1500;     // 1.5 s total budget
  const sources = [];
  const seen = new WeakSet();
  const recordSource = (source, markers) => {
    if (!markers || markers.length === 0) return;
    sources.push({ source, count: markers.length, markers });
  };

  // --- 1. Well-known globals (fast path) ---
  for (const key of WELL_KNOWN_GLOBALS) {
    if (Date.now() > deadline) break;
    let value;
    try { value = window[key]; } catch (_) { continue; }
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    try {
      const markers = findMarkerArray(value);
      if (markers.length > 0) recordSource(`window.${key}`, markers.slice(0, limit));
    } catch (_) {}
  }

  // --- 2. JSON-LD scripts (LocalBusiness / Place / ItemListElement) ---
  if (Date.now() < deadline) {
    const jsonLdMarkers = scanJsonLd();
    if (jsonLdMarkers.length > 0) recordSource("script[type='application/ld+json']", jsonLdMarkers.slice(0, limit));
  }

  // --- 3. Inline JSON scripts ---
  if (Date.now() < deadline) {
    for (const script of document.querySelectorAll(
      'script[type="application/json"], script#__NEXT_DATA__, script#__NUXT__, script#__INITIAL_STATE__'
    )) {
      if (Date.now() > deadline) break;
      const text = script.textContent || "";
      if (!text || text.length > 4_000_000) continue;
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { continue; }
      try {
        const markers = findMarkerArray(parsed);
        if (markers.length > 0) {
          const id = script.id ? `#${script.id}` : `[type='${script.getAttribute("type") || ""}']`;
          recordSource(`script${id}`, markers.slice(0, limit));
        }
      } catch (_) {}
    }
  }

  // --- 4. data-* attributes carrying JSON (Inertia, livewire, etc.) ---
  if (Date.now() < deadline) {
    for (const el of document.querySelectorAll("[data-page], [data-locations], [data-stores], [data-markers], [data-map-data]")) {
      if (Date.now() > deadline) break;
      for (const attr of el.attributes) {
        if (!/^data-/.test(attr.name)) continue;
        const raw = attr.value;
        if (!raw || raw.length < 8 || raw[0] !== "{" && raw[0] !== "[") continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { continue; }
        try {
          const markers = findMarkerArray(parsed);
          if (markers.length > 0) recordSource(`[${attr.name}]`, markers.slice(0, limit));
        } catch (_) {}
      }
    }
  }

  // --- 5. Cached fetch/XHR responses captured by our network hook ---
  if (Date.now() < deadline) {
    for (const cached of findCachedResponseSources(limit)) sources.push(cached);
  }

  // --- 6. Generic window.* sweep ---
  if (Date.now() < deadline) {
    const skip = new Set([
      "window", "self", "top", "parent", "frames",
      "document", "location", "navigator", "history",
      "localStorage", "sessionStorage", "console", "performance",
      "chrome", "browser", "crypto", "indexedDB", "caches",
    ]);
    for (const key of Object.getOwnPropertyNames(window)) {
      if (Date.now() > deadline) break;
      if (skip.has(key) || key.startsWith("__MMS_") || WELL_KNOWN_GLOBALS.includes(key)) continue;
      let value;
      try { value = window[key]; } catch (_) { continue; }
      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      try {
        const markers = findMarkerArray(value);
        if (markers.length > 0) recordSource(`window.${key}`, markers.slice(0, limit));
      } catch (_) {}
    }
  }

  // Pick the largest single source as the primary answer, but expose every
  // candidate so the side panel can show a list when results are split.
  sources.sort((a, b) => b.count - a.count);
  return {
    count: sources[0]?.count || 0,
    source: sources[0]?.source || null,
    markers: sources[0]?.markers || [],
    sources: sources.map(({ source, count }) => ({ source, count })),
  };
}

// Globals checked first because, on most modern frameworks, they always
// hold the page state if it exists at all. Order is best-bet first.
const WELL_KNOWN_GLOBALS = [
  "__NEXT_DATA__",
  "__NUXT__",
  "__APOLLO_STATE__",
  "__INITIAL_STATE__",
  "__PRELOADED_STATE__",
  "__INITIAL_DATA__",
  "__REDUX_STATE__",
  "__REACT_QUERY_STATE__",
  "__INERTIA__",
  "__SVELTE__",
  "INITIAL_STATE",
  "INITIAL_DATA",
  "PAGE_DATA",
  "pageData",
  "appData",
  "siteData",
  "locations",
  "stores",
  "markers",
  "places",
  "branches",
  "dealers",
];

// JSON-LD: walk every <script type="application/ld+json"> looking for
// schema.org Place / LocalBusiness / ItemListElement entries. These are
// rich structured data — name, address, phone, geo all in one shot.
function scanJsonLd() {
  const out = [];
  const seenKeys = new Set();
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = script.textContent || "";
    if (!text) continue;
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { continue; }
    extractJsonLdEntities(parsed, (entity) => {
      const lat = Number(entity.geo?.latitude ?? entity.geo?.lat);
      const lng = Number(entity.geo?.longitude ?? entity.geo?.lng ?? entity.geo?.lon);
      if (!validLatLng(lat, lng)) return;
      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      out.push({
        lat, lng,
        name: typeof entity.name === "string" ? entity.name : "",
        address: jsonLdAddress(entity.address),
        phone: typeof entity.telephone === "string" ? entity.telephone : "",
        url: typeof entity.url === "string" ? entity.url : "",
      });
    });
  }
  return out;
}

function extractJsonLdEntities(node, push) {
  if (!node) return;
  if (Array.isArray(node)) { for (const x of node) extractJsonLdEntities(x, push); return; }
  if (typeof node !== "object") return;

  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  const isPlace = types.some((t) =>
    typeof t === "string" &&
    /Place|LocalBusiness|Restaurant|Store|Hotel|Hospital|Pharmacy|MedicalClinic|Dentist|AutoDealer|Bank|Library|Museum|TouristAttraction|Park|GasStation|FoodEstablishment/i.test(t)
  );
  if (isPlace && node.geo) push(node);

  if (node["@graph"]) extractJsonLdEntities(node["@graph"], push);
  if (node.itemListElement) extractJsonLdEntities(node.itemListElement, push);
  if (node.item) extractJsonLdEntities(node.item, push);
  // Generic recurse — some publishers nest businesses arbitrarily.
  for (const value of Object.values(node)) {
    if (value && typeof value === "object" && value !== node["@graph"] && value !== node.itemListElement) {
      extractJsonLdEntities(value, push);
    }
  }
}

function jsonLdAddress(addr) {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  if (typeof addr !== "object") return "";
  const parts = [
    addr.streetAddress,
    addr.addressLocality,
    addr.addressRegion,
    addr.postalCode,
    addr.addressCountry,
  ].map((part) => (typeof part === "string" ? part : (part?.name || "")));
  return parts.filter(Boolean).join(", ");
}

function installNetworkResponseCacheHook() {
  if (window.__MMS_RESPONSE_CACHE_HOOKED__) return;
  window.__MMS_RESPONSE_CACHE_HOOKED__ = true;
  const cache = (window.__MMS_RESPONSE_CACHE__ ||= []);
  const MAX_ENTRIES = 40;
  const MAX_BYTES = 8 * 1024 * 1024;       // 8 MB total budget for cached bodies
  const MAX_PER_RESPONSE = 2_000_000;
  let totalBytes = cache.reduce((n, e) => n + (e.text?.length || 0), 0);

  const record = (entry) => {
    if (!entry?.url || !entry.text) return;
    if (!isLikelyJsonResponse(entry.url, entry.contentType, entry.text)) return;
    const text = entry.text.slice(0, MAX_PER_RESPONSE);
    cache.push({
      url: entry.url,
      contentType: entry.contentType || "",
      status: entry.status || 0,
      text,
      ts: Date.now(),
    });
    totalBytes += text.length;
    // Evict oldest until we're back under both caps.
    while (cache.length > 0 && (cache.length > MAX_ENTRIES || totalBytes > MAX_BYTES)) {
      const dropped = cache.shift();
      totalBytes -= dropped.text?.length || 0;
    }
  };

  // Drop the cache when the tab is being torn down so we don't hold on to
  // hundreds of MB across SPA reloads.
  const clearCache = () => { cache.length = 0; totalBytes = 0; };
  window.addEventListener("pagehide", clearCache, { once: false });
  window.addEventListener("beforeunload", clearCache, { once: false });

  if (typeof window.fetch === "function" && !window.fetch.__mmsHooked) {
    const originalFetch = window.fetch;
    async function hookedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = response.url || requestUrl(args[0]);
        const contentType = response.headers?.get?.("content-type") || "";
        if (isLikelyJsonUrl(url) || /json|geojson/i.test(contentType)) {
          response.clone().text().then((text) => record({
            url,
            contentType,
            status: response.status,
            text,
          })).catch(() => {});
        }
      } catch (_) {}
      return response;
    }
    hookedFetch.__mmsHooked = true;
    window.fetch = hookedFetch;
  }

  if (typeof window.XMLHttpRequest === "function" && !window.XMLHttpRequest.__mmsHooked) {
    const OriginalXHR = window.XMLHttpRequest;
    function HookedXHR() {
      const xhr = new OriginalXHR();
      let url = "";
      const originalOpen = xhr.open;
      xhr.open = function (method, requestUrlValue, ...rest) {
        url = requestUrl(requestUrlValue);
        return originalOpen.call(this, method, requestUrlValue, ...rest);
      };
      xhr.addEventListener?.("loadend", () => {
        try {
          const contentType = xhr.getResponseHeader?.("content-type") || "";
          if (!isLikelyJsonUrl(url) && !/json|geojson/i.test(contentType)) return;
          if (xhr.responseType && xhr.responseType !== "text") return;
          record({ url, contentType, status: xhr.status, text: xhr.responseText || "" });
        } catch (_) {}
      });
      return xhr;
    }
    HookedXHR.prototype = OriginalXHR.prototype;
    Object.setPrototypeOf(HookedXHR, OriginalXHR);
    HookedXHR.__mmsHooked = true;
    window.XMLHttpRequest = HookedXHR;
  }
}

function findCachedResponseSources(limit) {
  const out = [];
  for (const entry of window.__MMS_RESPONSE_CACHE__ || []) {
    try {
      const markers = extractMarkersFromJsonText(entry.text);
      if (markers.length > 0) {
        out.push({
          source: `response:${entry.url}`,
          count: markers.length,
          markers: markers.slice(0, limit),
        });
      }
    } catch (_) {}
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

function isLikelyJsonResponse(url, contentType, text) {
  if (isLikelyJsonUrl(url) || /json|geojson/i.test(contentType || "")) return true;
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function isLikelyJsonUrl(url) {
  const u = String(url || "");
  if (/\.json(?:\b|$|\?)/i.test(u)) return true;
  if (/format=json|type=json|f=json|output=json/i.test(u)) return true;
  // Endpoint path keywords associated with locator data — wide net but
  // gated by content-type at the call site so false positives are cheap.
  return /\/api\/|\/graphql|\/gql\b|geojson|location|locations|stores|markers|pin|pins|branches|dealers|outlets|places|locator|find-?a|near-?me|search|nearby|providers|facilities|clinics|pharmacies/i.test(u);
}

function requestUrl(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  try { return input.url || String(input); } catch (_) { return ""; }
}

function postProgress(body, chunk) {
  window.postMessage({ source: FROM_PAGE, token: BRIDGE_TOKEN, id: -1, progress: body, chunk }, "*");
}

function serializeDetectInstance(instance) {
  if (!instance || typeof instance !== "object") return null;
  const out = {};
  for (const key of ["kind", "selector", "count"]) {
    if (instance[key] !== undefined) out[key] = instance[key];
  }
  return out;
}
