// src/injected/page-script.js
// MAIN-world entry point. Loaded by the content script appending a
// <script type="module" src="..."> to the page. Because we declared it
// in web_accessible_resources, the page can load it.
//
// Responsibilities:
//   1. Install library hooks (Leaflet/Mapbox/Google) at document_start.
//   2. Listen for window.postMessage commands from the content script.
//   3. Drive the detector + adapters and post results back.
//
// This file runs in the PAGE'S JS context — it can see window.L, but it
// CANNOT see chrome.* APIs. All chrome.* calls happen in the content
// script, which bridges via window.postMessage.

import { installAllHooks, detectAll, getAdapter } from "./detector.js";

const TO_PAGE   = "MMS_TO_PAGE";
const FROM_PAGE = "MMS_FROM_PAGE";

installAllHooks();

window.addEventListener("message", async (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.source !== TO_PAGE) return;

  const { id, cmd, payload } = data;
  try {
    const result = await handle(cmd, payload);
    reply(id, { ok: true, result });
  } catch (e) {
    reply(id, { ok: false, error: e.message, stack: e.stack });
  }
});

function reply(id, body) {
  window.postMessage({ source: FROM_PAGE, id, ...body }, "*");
}

async function handle(cmd, payload) {
  switch (cmd) {
    case "DETECT": {
      const results = await detectAll();
      // Strip non-serializable parts (map/marker objects) before posting.
      return results.map(r => ({
        adapter:    r.adapter,
        confidence: r.confidence,
        reason:     r.reason,
        instanceCount: r.instances.length,
        instances: r.instances.map(serializeDetectInstance),
      }));
    }

    case "ENUMERATE": {
      const { adapterName, instanceIndex = 0, expandClusters = true, schemaHint = null } = payload || {};
      const results = await detectAll();
      const chosen  = results.find(r => r.adapter === adapterName);
      if (!chosen) throw new Error(`No detection for ${adapterName}`);
      const instance = chosen.instances[instanceIndex]
        || ((adapterName === "List (cards/rows)" && schemaHint?.listSelector)
          ? { kind: "list", selector: schemaHint.listSelector }
          : null);
      if (!instance) throw new Error(`No instance #${instanceIndex} for ${adapterName}`);

      const adapter = new chosen.ctor();
      const markers = await adapter.enumerateMarkers(instance, { expandClusters, schemaHint });

      // Emit ~20 progress updates across the run, regardless of total.
      // Each update ships both the running count AND the newly-extracted
      // slice of markers so the sidepanel can render a live preview.
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

    default:
      throw new Error(`Unknown cmd: ${cmd}`);
  }
}

function postProgress(body, chunk) {
  window.postMessage({ source: FROM_PAGE, id: -1, progress: body, chunk }, "*");
}

function serializeDetectInstance(instance) {
  if (!instance || typeof instance !== "object") return null;
  const out = {};
  for (const key of ["kind", "selector", "count"]) {
    if (instance[key] !== undefined) out[key] = instance[key];
  }
  return out;
}
