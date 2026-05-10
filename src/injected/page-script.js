// src/injected/page-script.js
// MAIN-world entry point. Loaded by the content script appending a
// <script type="module" src="..."> to the page.

import { installAllHooks, detectAll } from "./detector.js";
import { extractMarkersFromJsonText, findMarkerArray } from "../shared/network-fetch.js";

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

async function handle(cmd, payload) {
  switch (cmd) {
    case "DETECT": {
      const results = await detectAll();
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
      const results = await detectAll();
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
      return findWindowDataSources(payload?.limit || 500);
    }

    default:
      throw new Error(`Unknown cmd: ${cmd}`);
  }
}

function findWindowDataSources(limit = 500) {
  const sources = [];
  const seen = new WeakSet();
  const skip = new Set([
    "window",
    "self",
    "top",
    "parent",
    "frames",
    "document",
    "location",
    "navigator",
    "history",
    "localStorage",
    "sessionStorage",
  ]);

  for (const key of Object.getOwnPropertyNames(window)) {
    if (skip.has(key) || key.startsWith("__MMS_")) continue;
    let value;
    try { value = window[key]; } catch (_) { continue; }
    const markers = scanDataValue(value, seen);
    if (markers.length > 0) {
      sources.push({ source: `window.${key}`, count: markers.length, markers: markers.slice(0, limit) });
    }
  }

  for (const cached of findCachedResponseSources(limit)) sources.push(cached);

  sources.sort((a, b) => b.count - a.count);
  return {
    count: sources[0]?.count || 0,
    source: sources[0]?.source || null,
    markers: sources[0]?.markers || [],
    sources: sources.map(({ source, count }) => ({ source, count })),
  };
}

function installNetworkResponseCacheHook() {
  if (window.__MMS_RESPONSE_CACHE_HOOKED__) return;
  window.__MMS_RESPONSE_CACHE_HOOKED__ = true;
  const cache = (window.__MMS_RESPONSE_CACHE__ ||= []);

  const record = (entry) => {
    if (!entry?.url || !entry.text) return;
    if (!isLikelyJsonResponse(entry.url, entry.contentType, entry.text)) return;
    cache.push({
      url: entry.url,
      contentType: entry.contentType || "",
      status: entry.status || 0,
      text: entry.text.slice(0, 2_000_000),
      ts: Date.now(),
    });
    while (cache.length > 40) cache.shift();
  };

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

function scanDataValue(value, seen, depth = 0) {
  if (!value || depth > 4) return [];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const direct = findMarkerArray(value);
  if (direct.length > 0) return direct;

  let best = [];
  let entries;
  try {
    entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  } catch (_) {
    return [];
  }
  for (const [, child] of entries) {
    const markers = scanDataValue(child, seen, depth + 1);
    if (markers.length > best.length) best = markers;
  }
  return best;
}

function isLikelyJsonResponse(url, contentType, text) {
  if (isLikelyJsonUrl(url) || /json|geojson/i.test(contentType || "")) return true;
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function isLikelyJsonUrl(url) {
  return /\.json(?:\b|$|\?)/i.test(String(url || "")) || /\/api\/|geojson|location|locations|stores|markers/i.test(String(url || ""));
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
