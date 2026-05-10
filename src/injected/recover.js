// src/injected/recover.js
// Hook-missed instance recovery, shared across map adapters.
//
// Background: every adapter monkey-patches its library's Map (and Marker)
// constructors at document_start so we can capture instances as they're
// built. That works on the first page load. It does NOT work when the
// extension is loaded — or the side panel is opened — AFTER the page has
// already constructed its map. In that case the constructor hook never
// runs and our adapters say "hook missed", which used to result in
// "Library: generic" / 0 markers in the side panel.
//
// This file gives each adapter two cheap ways to recover the live Map
// instance after the fact:
//
//   1. recoverFromGlobals(predicate)  — walks `window.*` (depth 1, plus
//      one level into namespaces) looking for objects that quack like
//      the library's Map. Most sites stash the map under window.map /
//      window.someApp.map / etc., so this catches the common case.
//
//   2. recoverFromContainer(el, predicate) — walks an HTMLElement's own
//      property names (including non-enumerable ones) looking for the
//      Map. Works for libraries that stash internal state on the DOM
//      container (Google Maps' __gm, OpenLayers viewport refs, etc.).
//
// Both helpers are bounded — they refuse to descend into giant framework
// namespaces (e.g. React internals) and they swallow access errors so
// cross-origin getters can't throw the page-script.

const SKIP_GLOBALS = new Set([
  "window", "document", "self", "top", "parent", "frames",
  "navigator", "location", "history", "screen", "performance",
  "console", "crypto", "indexedDB", "localStorage", "sessionStorage",
  "chrome", "browser", "google", "L", "ol", "mapboxgl", "maplibregl",
  "deck", "Deck", "React", "ReactDOM", "Vue", "Angular",
]);

export function recoverFromGlobals(predicate, { maxOuterKeys = 8000, maxInnerKeys = 200 } = {}) {
  const found = new Set();
  let names;
  try { names = Object.getOwnPropertyNames(window); } catch (_) { return []; }

  let processed = 0;
  for (const k of names) {
    if (++processed > maxOuterKeys) break;

    let v;
    try { v = window[k]; } catch (_) { continue; }
    if (!v || typeof v !== "object") continue;

    safeTest(v, predicate, found);

    // One more level deep, but only for namespace-shaped objects (small
    // own-property count). This catches `window.app.map`, `window.MAP.instance`
    // patterns without crawling React/Vue trees.
    if (SKIP_GLOBALS.has(k)) continue;
    let inner;
    try { inner = Object.getOwnPropertyNames(v); } catch (_) { continue; }
    if (inner.length === 0 || inner.length > maxInnerKeys) continue;
    for (const k2 of inner) {
      let v2;
      try { v2 = v[k2]; } catch (_) { continue; }
      if (!v2 || typeof v2 !== "object") continue;
      safeTest(v2, predicate, found);
    }
  }
  return Array.from(found);
}

export function recoverFromContainer(container, predicate, { maxDepth = 4 } = {}) {
  if (!container) return null;
  const seen = new WeakSet();

  const visit = (val, depth) => {
    if (!val || typeof val !== "object" || depth > maxDepth || seen.has(val)) return null;
    seen.add(val);
    try { if (predicate(val)) return val; } catch (_) {}

    let keys;
    try { keys = Object.getOwnPropertyNames(val); } catch (_) { return null; }
    if (keys.length > 400) return null;     // bail on giant framework objects
    for (const k of keys) {
      let next;
      try { next = val[k]; } catch (_) { continue; }
      if (next && typeof next === "object") {
        const found = visit(next, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  return visit(container, 0);
}

function safeTest(value, predicate, sink) {
  try { if (predicate(value)) sink.add(value); } catch (_) {}
}
