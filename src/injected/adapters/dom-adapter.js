// src/injected/adapters/dom-adapter.js
// Last-resort fallback: "click each marker and scrape the popup that
// appears." This is how you'd scrape a map by hand, automated.
//
// Preconditions:
//   - The caller provides `markerSelector` — a CSS selector matching
//     every pin in the DOM. The visual marker picker (pick-mode in the
//     content script) produces these.
//   - If popupSelector is omitted, popup candidates are scored by visibility,
//     contact/address text, and whether they appeared after the click.
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
import { applySchemaFields } from "../../shared/schema-selectors.js";
import { choosePopupCandidate, isClusterElement } from "../../content/capture-heuristics.js";

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
    let nodes = Array.from(document.querySelectorAll(sel));
    if (opts.expandClusters && opts.mode === "zoom") {
      nodes = await expandDomClusters(sel);
    }

    const skipClusters = opts.expandClusters && opts.mode === "zoom";
    return nodes.filter((el) => !skipClusters || !isClusterElement(el)).map((el, i) => ({
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

    const before = new Set(document.querySelectorAll("body *"));
    el.click();
    const candidates = await capturePopupCandidates(before);

    const best = choosePopupCandidate(candidates);
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
  return applySchemaFields(rootEl, schemaHint);
}

async function expandDomClusters(selector) {
  const visited = new Set();
  for (let depth = 0; depth < 5; depth++) {
    const clusters = Array.from(document.querySelectorAll(selector)).filter(isClusterElement);
    let clicked = false;

    for (const cluster of clusters) {
      const key = clusterCentroidKey(cluster);
      if (visited.has(key)) continue;
      visited.add(key);
      clicked = true;
      fireClick(cluster);
      await waitForDomSettle(500, 2000);
    }

    if (!clicked) break;
  }
  return Array.from(document.querySelectorAll(selector));
}

function fireClick(el) {
  try {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  } catch (_) {
    el.click?.();
  }
}

function clusterCentroidKey(el) {
  const rect = el.getBoundingClientRect?.();
  if (!rect) return `${(el.textContent || "").trim()}:${el.className || ""}`;
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  return `${x}:${y}:${(el.textContent || "").trim()}`;
}

function waitForDomSettle(settleMs = 500, maxMs = 2000) {
  return new Promise((resolve) => {
    let done = false;
    let settleTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(settleTimer);
      clearTimeout(maxTimer);
      observer.disconnect();
      resolve();
    };
    const bump = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, settleMs);
    };
    const observer = new MutationObserver(bump);
    const maxTimer = setTimeout(finish, maxMs);
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    bump();
  });
}

async function capturePopupCandidates(before) {
  await sleep(500);
  const candidates = [];
  document.querySelectorAll("body *").forEach((node) => {
    if (before.has(node)) return;
    const text = (node.textContent || "").trim();
    if (!text) return;
    candidates.push({
      node,
      path: node.tagName?.toLowerCase?.() || "element",
      outerHTML: node.outerHTML || "",
      text,
      textLen: text.length,
      becameVisible: true,
      wasEmptyBefore: true,
    });
  });
  return candidates;
}
