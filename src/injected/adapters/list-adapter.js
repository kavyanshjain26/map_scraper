// src/injected/adapters/list-adapter.js
// Scrapes repeating list/card patterns from a page (e.g. the sidebar
// of a dealer locator). Doesn't use any map library — just walks the
// DOM for a pattern taught by the user.
//
// Shape:
//   - teachHint.listSelector   → selector matching every card
//   - schemaHint.fields        → selectors run inside each card
//
// If schemaHint isn't present, we fall back to grabbing textContent
// of each match.

import { BaseAdapter } from "./base-adapter.js";
import { applySchemaFields } from "../../shared/schema-selectors.js";

const DETECTED = (window.__MMS_LIST_DETECTED__ ||= { count: 0, selector: null });

// Heuristic pre-scan: look for repeating card-like patterns on the page
// WITHOUT any user click. We look for a parent whose direct children
// share the same tag + a common class, ≥3 repetitions, ≥40 chars of
// text each (skip nav menus, tag clouds, etc.).
export function preDetectList() {
  // Bound the scan — on a 50k-element page we don't want to visit every
  // node. Start with elements likely to be card containers (the most
  // common shapes have 3+ direct children with semantic classes/tags),
  // and stop after a generous budget. We also skip giant containers
  // (>800 kids) up front because those are usually virtualisation
  // wrappers, not card lists.
  const SCAN_BUDGET = 6000;
  const MIN_CARDS = 3;
  const MAX_CARDS = 500;
  let scanned = 0;
  let best = { count: 0, selector: null };

  // Fast pre-filter: only inspect parents whose first child has a class
  // (cards almost always have one). Falls back to a full sweep only if
  // that early pass found nothing.
  const collectFromQuery = (selector) => {
    let nodes;
    try { nodes = document.querySelectorAll(selector); } catch (_) { return; }
    for (const parent of nodes) {
      if (++scanned > SCAN_BUDGET) return;
      considerParent(parent);
    }
  };

  const considerParent = (parent) => {
    const kids = parent.children;
    if (!kids || kids.length < MIN_CARDS || kids.length > MAX_CARDS) return;

    const tag = kids[0].tagName;
    for (let i = 1; i < kids.length; i++) {
      if (kids[i].tagName !== tag) return;
    }

    const firstClasses = kids[0].classList || [];
    let shared = null;
    for (const cls of firstClasses) {
      let all = true;
      for (let i = 1; i < kids.length; i++) {
        if (!kids[i].classList?.contains(cls)) { all = false; break; }
      }
      if (all) { shared = cls; break; }
    }
    if (!shared) return;

    let textRich = 0;
    for (const k of kids) {
      const t = (k.textContent || "").trim();
      if (t.length >= 40) textRich++;
    }
    if (textRich < Math.max(MIN_CARDS, kids.length * 0.6)) return;

    if (kids.length > best.count) {
      best = { count: kids.length, selector: `${tag.toLowerCase()}.${cssEscape(shared)}` };
    }
  };

  // Pass 1: parents whose first child has a class — cheap and covers >95%
  // of card layouts.
  collectFromQuery("*:has(> *[class])");
  // Pass 2 (fallback): broader sweep if pass 1 found nothing. The :has
  // query above is supported in modern Chrome but we still want a path
  // through if it ever fails to compile or returns nothing.
  if (!best.selector && scanned < SCAN_BUDGET) {
    const all = document.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      if (++scanned > SCAN_BUDGET) break;
      considerParent(all[i]);
    }
  }

  DETECTED.count = best.count;
  DETECTED.selector = best.selector;
  return best;
}

export class ListAdapter extends BaseAdapter {
  static get name() { return "List (cards/rows)"; }

  async detect() {
    const hit = preDetectList();
    if (!hit.selector) {
      return { confidence: 0, reason: "no repeating card pattern", instances: [] };
    }
    return {
      confidence: 0.5,
      reason: `${hit.count} repeating card(s) found`,
      instances: [{ kind: "list", selector: hit.selector, count: hit.count }],
    };
  }

  async enumerateMarkers(instance, opts = {}) {
    // Prefer the user-taught selector from teach flow, else the auto-detected one.
    const sel = opts.schemaHint?.listSelector || instance.teachHint?.listSelector || instance.selector;
    if (!sel) throw new Error("ListAdapter needs a list selector");
    const nodes = document.querySelectorAll(sel);
    return Array.from(nodes).map((el, i) => ({
      id: `list-${i}`,
      lat: null,
      lng: null,
      raw: { kind: "list-item", el },
    }));
  }

  async extractMarkerData(record, schemaHint = null) {
    const out = { lat: null, lng: null };
    const el = record.raw?.el;
    if (!el) return out;

    if (schemaHint?.fields?.length) {
      Object.assign(out, applySchemaFields(el, schemaHint));
    } else {
      // No schema — grab the whole card's text as one blob.
      out.text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
    }
    return out;
  }
}

function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^\w-]/g, (ch) => "\\" + ch);
}
