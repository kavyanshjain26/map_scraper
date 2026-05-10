// src/injected/adapters/deck-adapter.js
// deck.gl renders through WebGL, but layers usually keep their raw data arrays
// on layer.props.data. The hook captures Deck instances and setProps calls so
// enumeration can read those arrays directly.

import { BaseAdapter } from "./base-adapter.js";
import { asCoords } from "../../shared/network-fetch.js";
import { recoverFromGlobals } from "../recover.js";

const DECK_INSTANCES = (window.__MMS_DECK_INSTANCES__ ||= []);

export function installDeckHook() {
  if (window.__MMS_DECK_HOOKED__) return;

  const tryHook = () => {
    let hooked = false;
    hooked = hookDeckNamespace(window.deck) || hooked;
    hooked = hookDeckNamespace(window) || hooked;
    if (hooked) window.__MMS_DECK_HOOKED__ = true;
    return hooked;
  };

  if (tryHook()) return;
  let tries = 0;
  const timer = setInterval(() => {
    if (tryHook() || ++tries > 80) clearInterval(timer);
  }, 100);
}

function hookDeckNamespace(ns) {
  if (!ns?.Deck || ns.Deck.__mmsHooked) return false;
  const OriginalDeck = ns.Deck;

  function HookedDeck(...args) {
    const instance = new OriginalDeck(...args);
    registerDeckInstance(instance, args[0] || {});
    return instance;
  }
  HookedDeck.prototype = OriginalDeck.prototype;
  Object.setPrototypeOf(HookedDeck, OriginalDeck);
  HookedDeck.__mmsHooked = true;
  ns.Deck = HookedDeck;
  return true;
}

function registerDeckInstance(instance, initialProps) {
  if (!instance || instance.__mmsDeckRegistered) return;
  instance.__mmsDeckRegistered = true;
  instance.__mmsLayerSnapshots = [];
  captureLayers(instance, initialProps?.layers);

  if (typeof instance.setProps === "function" && !instance.__mmsSetPropsHooked) {
    const originalSetProps = instance.setProps;
    instance.setProps = function (props = {}) {
      captureLayers(this, props.layers);
      return originalSetProps.call(this, props);
    };
    instance.__mmsSetPropsHooked = true;
  }

  try { DECK_INSTANCES.push(instance); } catch (_) {}
}

function captureLayers(instance, layers) {
  for (const layer of flattenLayers(layers)) {
    if (!layer?.props) continue;
    const data = layer.props.data;
    if (!data) continue;
    instance.__mmsLayerSnapshots.push({
      id: layer.id || layer.props.id || `layer-${instance.__mmsLayerSnapshots.length}`,
      layer,
      props: layer.props,
      data,
    });
    if (instance.__mmsLayerSnapshots.length > 100) instance.__mmsLayerSnapshots.shift();
  }
}

function flattenLayers(layers) {
  if (!layers) return [];
  const out = [];
  const stack = Array.isArray(layers) ? [...layers] : [layers];
  while (stack.length) {
    const layer = stack.shift();
    if (!layer) continue;
    if (Array.isArray(layer)) {
      stack.push(...layer);
      continue;
    }
    out.push(layer);
    if (Array.isArray(layer.props?.layers)) stack.push(...layer.props.layers);
  }
  return out;
}

export class DeckAdapter extends BaseAdapter {
  static get name() { return "deck.gl"; }

  async detect() {
    const instances = DECK_INSTANCES.slice();
    const hasGlobal = !!(window.deck?.Deck || window.Deck);
    if (instances.length === 0 && !hasGlobal) {
      return { confidence: 0, reason: "no deck.gl", instances: [] };
    }
    if (instances.length > 0) {
      return {
        confidence: 0.86,
        reason: `hooked ${instances.length} Deck instance(s)`,
        instances: instances.map((deck) => ({ kind: "live", deck })),
      };
    }

    // Hook missed construction. deck.gl Deck instances have a distinctive
    // shape (setProps + props.layers + a canvas/animationLoop). Walk
    // window.* to find them.
    const recovered = recoverFromGlobals(isDeckInstance);
    if (recovered.length > 0) {
      for (const deck of recovered) {
        if (!DECK_INSTANCES.includes(deck)) {
          try { registerDeckInstance(deck, deck.props || {}); } catch (_) {}
        }
      }
      return {
        confidence: 0.8,
        reason: `recovered ${recovered.length} Deck instance(s) from page state`,
        instances: recovered.map((deck) => ({ kind: "live", deck })),
      };
    }

    // Last resort: still report the library so the side panel doesn't fall
    // back to "generic". The enumerator will explain why a reload is needed.
    return {
      confidence: 0.5,
      reason: "deck.gl present, hook missed construction — reload page for full extraction",
      instances: [{ kind: "dom-only" }],
    };
  }

  get rendersToCanvas() { return true; }

  async enumerateMarkers(instance) {
    if (instance.kind !== "live") {
      throw new Error("deck.gl DOM-only enumeration not supported - reload with the extension active");
    }

    const out = [];
    let id = 0;
    const snapshots = getLayerSnapshots(instance.deck);
    for (const snapshot of snapshots) {
      const rows = dataRows(snapshot.data);
      for (const row of rows) {
        const coords = deckCoords(row, snapshot.props);
        if (!coords) continue;
        out.push({
          id: `deck-${snapshot.id}-${id++}`,
          lat: coords.lat,
          lng: coords.lng,
          raw: { kind: "deck-row", row, layerId: snapshot.id },
        });
      }
    }
    return dedupeByCoords(out);
  }

  async extractMarkerData(record) {
    const out = { lat: record.lat, lng: record.lng };
    const row = record.raw?.row;
    if (!row || typeof row !== "object") return out;

    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue;
      if (/^(lat|latitude|lng|lon|long|longitude|coordinates|position|geometry)$/i.test(key)) continue;
      const type = typeof value;
      if (type === "string" || type === "number" || type === "boolean") out[key] = value;
      else if (type === "object" && !Array.isArray(value)) {
        for (const [subKey, subValue] of Object.entries(value)) {
          const subType = typeof subValue;
          if (subType === "string" || subType === "number" || subType === "boolean") {
            out[`${key}_${subKey}`] = subValue;
          }
        }
      }
    }
    return out;
  }
}

function isDeckInstance(o) {
  if (!o || typeof o !== "object") return false;
  const Deck = window.deck?.Deck || window.Deck;
  if (Deck) {
    try { if (o instanceof Deck) return true; } catch (_) { /* fall through */ }
  }
  // Duck-type: a Deck instance has setProps, finalize, and a props bag.
  return typeof o.setProps === "function"
      && typeof o.finalize === "function"
      && o.props && typeof o.props === "object";
}

function getLayerSnapshots(deck) {
  const snapshots = [...(deck.__mmsLayerSnapshots || [])];
  for (const layer of flattenLayers(deck.props?.layers)) {
    if (layer?.props?.data) {
      snapshots.push({
        id: layer.id || layer.props.id || `layer-${snapshots.length}`,
        layer,
        props: layer.props,
        data: layer.props.data,
      });
    }
  }
  return snapshots;
}

function dataRows(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.features)) return data.features;
  if (typeof data[Symbol.iterator] === "function") {
    try { return Array.from(data); } catch (_) { return []; }
  }
  return [];
}

function deckCoords(row, props = {}) {
  const direct = asCoords(row);
  if (direct) return direct;

  let pos = null;
  try {
    if (typeof props.getPosition === "function") pos = props.getPosition(row);
  } catch (_) {
    pos = null;
  }
  pos ||= row?.position || row?.coordinates || row?.coordinate || row?.lngLat || row?.lonLat;

  if (Array.isArray(pos) && pos.length >= 2) {
    const [lng, lat] = pos.map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  if (pos && typeof pos === "object") return asCoords(pos);
  return null;
}

function dedupeByCoords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.lat.toFixed(6)},${record.lng.toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
