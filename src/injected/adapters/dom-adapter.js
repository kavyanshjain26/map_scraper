// src/injected/adapters/dom-adapter.js
// Last-resort fallback: "click each marker and scrape the popup that
// appears." This is how you'd scrape a map by hand, automated.
//
// Preconditions:
//   - The caller provides `markerSelector` — a CSS selector matching
//     every pin in the DOM. The visual marker picker (pick-mode in the
//     content script) produces these.
//   - `popupSelector` is optional; if omitted we capture the largest
//     element added to the DOM after each click, same way teach mode
//     does. If provided, we look for that selector specifically.
//
// Caveats:
//   - No lat/lng — the DOM position uses pixels, not geography. If the
//     popup contains a coordinate or an address, the schemaHint extracts
//     it. Otherwise output is name/address/etc. only.
//   - Slow: we click serially with ~200ms per pin to let popups render.
//     A page with 300 pins takes ~60 seconds. Show progress.
//   - Fragile: anti-bot heuristics may fire on rapid synthetic clicks.
//     Use sparingly.

import { BaseAdapter } from "./base-adapter.js";

export class DOMAdapter extends BaseAdapter {
  static get name() { return "DOM (generic)"; }

  async detect() {
    return {
      confidence: 0.1,
      reason: "generic fallback — needs a marker selector from the visual picker",
      instances: [{ kind: "generic" }],
    };
  }

  async enumerateMarkers(instance, opts = {}) {
    const sel = instance.teachHint?.markerSelector
             || opts.schemaHint?.markerSelector;
    if (!sel) {
      throw new Error("DOMAdapter needs markerSelector — use the visual picker first");
    }
    const nodes = document.querySelectorAll(sel);
    return Array.from(nodes).map((el, i) => ({
      id: `dom-${i}`,
      lat: null,
      lng: null,
      raw: { kind: "dom-element", el },
    }));
  }

  async extractMarkerData(record, schemaHint = null) {
    const out = { lat: null, lng: null };
    const el = record.raw?.el;
    if (!el) return out;

    // Click the marker and wait up to 1 second for something to appear.
    const before = new Set(document.querySelectorAll("body *"));
    el.click();
    await sleep(250);

    // Find the largest newly-added subtree.
    let best = null;
    document.querySelectorAll("body *").forEach(node => {
      if (before.has(node)) return;
      const text = (node.textContent || "").trim();
      if (!best || text.length > best.textLen) {
        best = { node, textLen: text.length };
      }
    });

    if (best?.node) {
      const html = best.node.outerHTML;
      out.popup_html = html.length > 4000 ? html.slice(0, 4000) : html;
      if (schemaHint) Object.assign(out, applySchema(best.node, schemaHint));
    } else if (el.title) {
      out.title = el.title;
    } else {
      out.text = (el.textContent || "").trim();
    }

    return out;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function applySchema(rootEl, schemaHint) {
  const out = {};
  for (const f of schemaHint.fields || []) {
    const el = rootEl.querySelector(f.selector);
    if (el) out[f.key] = (el.textContent || "").trim();
  }
  return out;
}
