// src/injected/detector.js
import { LeafletAdapter, installLeafletHook }     from "./adapters/leaflet-adapter.js";
import { MapboxAdapter,  installMapboxHook }      from "./adapters/mapbox-adapter.js";
import { GoogleMapsAdapter, installGoogleHook }   from "./adapters/google-maps-adapter.js";
import { OpenLayersAdapter, installOLHook }       from "./adapters/openlayers-adapter.js";
import { DeckAdapter, installDeckHook }           from "./adapters/deck-adapter.js";
import { ListAdapter }                            from "./adapters/list-adapter.js";
import { DOMAdapter }                             from "./adapters/dom-adapter.js";

export function installAllHooks() {
  installLeafletHook();
  installMapboxHook();
  installGoogleHook();
  installOLHook();
  installDeckHook();
}

const ADAPTERS = [
  LeafletAdapter,
  MapboxAdapter,
  GoogleMapsAdapter,
  OpenLayersAdapter,
  DeckAdapter,
  ListAdapter,     // sidebar/card scraper — lower confidence than libraries
  DOMAdapter,      // generic fallback, must be last
];

export async function detectAll() {
  const results = await Promise.all(
    ADAPTERS.map(async (Cls) => {
      const instance = new Cls();
      let out;
      try { out = await instance.detect(); }
      catch (e) { out = { confidence: 0, reason: `threw: ${e.message}`, instances: [] }; }
      return { adapter: Cls.name, ctor: Cls, ...out };
    })
  );
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

export function getAdapter(name) {
  const Cls = ADAPTERS.find(c => c.name === name);
  return Cls ? new Cls() : null;
}
