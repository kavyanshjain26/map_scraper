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
  const containers = document.querySelectorAll("*");
  let best = { count: 0, selector: null };

  for (const parent of containers) {
    const kids = parent.children;
    if (!kids || kids.length < 3 || kids.length > 500) continue;

    // All children same tag?
    const tag = kids[0].tagName;
    let allSameTag = true;
    for (const k of kids) {
      if (k.tagName !== tag) {
        allSameTag = false;
        break;
      }
    }
    if (!allSameTag) continue;

    // Find a class that all children share.
    const firstClasses = Array.from(kids[0].classList || []);
    const shared = firstClasses.find((cls) =>
      Array.from(kids).every((k) => k.classList?.contains(cls))
    );
    if (!shared) continue;

    // Filter by text density — skip nav rows, icon grids.
    let textRich = 0;
    for (const k of kids) {
      const t = (k.textContent || "").trim();
      if (t.length >= 40) textRich++;
    }
    if (textRich < Math.max(3, kids.length * 0.6)) continue;

    if (kids.length > best.count) {
      best = { count: kids.length, selector: `${tag.toLowerCase()}.${cssEscape(shared)}` };
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
