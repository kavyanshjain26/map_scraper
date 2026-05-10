import assert from "node:assert/strict";

import { escapeHtml } from "../src/shared/html.js";
import { applySchemaFields, selectFirstText } from "../src/shared/schema-selectors.js";
import { extractMarkersFromJsonText, findMarkerArray, pickBestMarkerEndpoint, asCoords, validLatLng, parseCoordString } from "../src/shared/network-fetch.js";
import { toCSV } from "../src/shared/export.js";
import { chooseDetectedLibrary, shouldTryListFirst } from "../src/sidepanel/strategy.js";
import { choosePopupCandidate, deriveMarkerSelector, scoreMarkerElement } from "../src/content/capture-heuristics.js";

class FakeNode {
  constructor(matches = {}) {
    this.matches = matches;
  }

  querySelector(selector) {
    if (selector === "!!bad") {
      throw new DOMException("Bad selector", "SyntaxError");
    }
    return this.matches[selector] || null;
  }
}

class FakeTextNode {
  constructor(text) {
    this.textContent = text;
  }
}

class FakeElement {
  constructor({
    tagName = "div",
    className = "",
    text = "",
    title = "",
    ariaLabel = "",
    style = {},
    parent = null,
  } = {}) {
    this.tagName = tagName.toUpperCase();
    this.className = className;
    this.textContent = text;
    this.title = title;
    this.parentElement = parent;
    this.children = [];
    this.attributes = new Map();
    this.style = style;
    this.classList = {
      length: className ? className.split(/\s+/).filter(Boolean).length : 0,
      contains: (cls) => className.split(/\s+/).includes(cls),
      [Symbol.iterator]: function* () {
        yield* className.split(/\s+/).filter(Boolean);
      },
    };
    if (ariaLabel) this.attributes.set("aria-label", ariaLabel);
    if (parent) parent.children.push(this);
  }

  getAttribute(name) {
    return this.attributes.get(name) || "";
  }

  closest(selector) {
    const parts = selector.split(",").map((part) => part.trim().toLowerCase());
    let cur = this;
    while (cur) {
      const tag = cur.tagName.toLowerCase();
      const cls = cur.className.toLowerCase();
      for (const part of parts) {
        if (part === tag) return cur;
        if (part.startsWith("[role='") && cur.getAttribute("role") === part.slice(7, -2)) return cur;
        if (part.startsWith("[class*='") && cls.includes(part.slice(9, -2))) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test("escapeHtml escapes content and attribute delimiters", () => {
  assert.equal(
    escapeHtml(`Tom & "Pins" <script data-x='1'>`),
    "Tom &amp; &quot;Pins&quot; &lt;script data-x=&#39;1&#39;&gt;",
  );
});

test("selectFirstText returns null for invalid selectors", () => {
  const root = new FakeNode();
  assert.equal(selectFirstText(root, "!!bad"), null);
});

test("applySchemaFields skips invalid or empty field selectors", () => {
  const root = new FakeNode({
    ".name": new FakeTextNode(" Main Store "),
    ".phone": new FakeTextNode(" 555-0100 "),
  });

  assert.deepEqual(
    applySchemaFields(root, {
      fields: [
        { key: "name", selector: ".name" },
        { key: "bad", selector: "!!bad" },
        { key: "", selector: ".phone" },
        { key: "missing", selector: ".missing" },
      ],
    }),
    { name: "Main Store" },
  );
});

test("chooseDetectedLibrary ignores detections without usable instances", () => {
  const winner = chooseDetectedLibrary([
    { adapter: "Google Maps", confidence: 0.3, instanceCount: 0 },
    { adapter: "Leaflet", confidence: 0.95, instanceCount: 1 },
    { adapter: "DOM (generic)", confidence: 0.1, instanceCount: 1 },
  ]);

  assert.equal(winner.adapter, "Leaflet");
});

test("list mode is tried before library only when no library is usable", () => {
  assert.equal(
    shouldTryListFirst({ hasListTeaching: true, detectedAdapter: "Leaflet" }),
    false,
  );
  assert.equal(
    shouldTryListFirst({ hasListTeaching: true, detectedAdapter: null }),
    true,
  );
});

test("findMarkerArray flattens nested marker objects", () => {
  const rows = findMarkerArray({
    data: {
      locations: [
        { lat: "12.9", lng: "77.6", name: "A", meta: { city: "BLR" } },
        { latitude: 13, longitude: 78, name: "B" },
      ],
    },
  });

  assert.deepEqual(rows, [
    { lat: 12.9, lng: 77.6, name: "A", meta_city: "BLR" },
    { lat: 13, lng: 78, name: "B" },
  ]);
});

test("extractMarkersFromJsonText parses GeoJSON response bodies", () => {
  const rows = extractMarkersFromJsonText(JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [77.6, 12.9] },
        properties: { name: "Clinic" },
      },
    ],
  }));

  assert.deepEqual(rows, [{ lat: 12.9, lng: 77.6, name: "Clinic" }]);
});

test("pickBestMarkerEndpoint prefers likely JSON location APIs over tiles", () => {
  const best = pickBestMarkerEndpoint([
    { url: "https://example.com/assets/tile/12/13/14.png", type: "image" },
    { url: "https://example.com/api/locations.json?brand=clinic", type: "xmlhttprequest" },
    { url: "https://api.mapbox.com/styles/v1/acme/style.json", type: "xmlhttprequest" },
  ]);

  assert.equal(best, "https://example.com/api/locations.json?brand=clinic");
});

test("scoreMarkerElement rewards map-positioned marker signals and penalizes nav chrome", () => {
  const map = new FakeElement({ className: "leaflet-container" });
  const nav = new FakeElement({ tagName: "nav" });
  const marker = new FakeElement({
    className: "leaflet-marker-icon",
    title: "Main Clinic",
    style: { position: "absolute", transform: "translate3d(10px, 20px, 0)" },
    parent: map,
  });
  const navIcon = new FakeElement({ tagName: "button", className: "icon", parent: nav });

  assert(scoreMarkerElement(marker) > scoreMarkerElement(navIcon));
});

test("deriveMarkerSelector ignores broad nav icons when marker signals are stronger", () => {
  const map = new FakeElement({ className: "leaflet-container" });
  const nav = new FakeElement({ tagName: "nav" });
  const marker = new FakeElement({
    tagName: "img",
    className: "pin icon",
    title: "Main Clinic",
    style: { position: "absolute", transform: "translate3d(10px, 20px, 0)" },
    parent: map,
  });
  new FakeElement({ tagName: "button", className: "icon", parent: nav });
  new FakeElement({ tagName: "button", className: "icon", parent: nav });

  const doc = {
    querySelectorAll(selector) {
      if (selector === ".pin") return [marker];
      if (selector === ".icon") return [marker, ...nav.children];
      if (selector === "img") return [marker];
      return [];
    },
  };

  assert.equal(deriveMarkerSelector(marker, doc), ".pin");
});

test("choosePopupCandidate favors visible contact-rich mutations over large generic blocks", () => {
  const best = choosePopupCandidate([
    {
      path: "body > div.hero",
      outerHTML: "<div>Welcome to our site with lots of generic marketing copy repeated.</div>",
      text: "Welcome to our site with lots of generic marketing copy repeated.",
      becameVisible: false,
      wasEmptyBefore: false,
    },
    {
      path: "body > div.popup",
      outerHTML: "<div><h3>Main Clinic</h3><a>Get directions</a><p>123 Main St</p><p>555-0100</p></div>",
      text: "Main Clinic Get directions 123 Main St 555-0100",
      becameVisible: true,
      wasEmptyBefore: true,
    },
  ]);

  assert.equal(best.path, "body > div.popup");
});

test("validLatLng rejects placeholders and out-of-range values", () => {
  assert.equal(validLatLng(0, 0), false);
  assert.equal(validLatLng(95, 50), false);
  assert.equal(validLatLng(45, 200), false);
  assert.equal(validLatLng(NaN, 50), false);
  assert.equal(validLatLng(12.9, 77.6), true);
  assert.equal(validLatLng(-90, -180), true);
});

test("parseCoordString handles 'lat,lng' and infers ordering by range", () => {
  assert.deepEqual(parseCoordString("12.9, 77.6"), { lat: 12.9, lng: 77.6 });
  // First value out of latitude range -> ordering must be lng,lat.
  assert.deepEqual(parseCoordString("100.5, 12.9"), { lat: 12.9, lng: 100.5 });
  assert.equal(parseCoordString("not a coord"), null);
  assert.equal(parseCoordString("0, 0"), null);
});

test("asCoords reads nested position/coords and string-encoded fields", () => {
  assert.deepEqual(asCoords({ position: { lat: 12.9, lng: 77.6 } }), { lat: 12.9, lng: 77.6 });
  assert.deepEqual(asCoords({ coordinates: [77.6, 12.9] }),         { lat: 12.9, lng: 77.6 });
  assert.deepEqual(asCoords({ location: "12.9,77.6" }),             { lat: 12.9, lng: 77.6 });
  // ESRI-style { attributes, geometry: {x, y} }.
  assert.deepEqual(
    asCoords({ attributes: { name: "X" }, geometry: { x: 77.6, y: 12.9 } }),
    { lat: 12.9, lng: 77.6 },
  );
  // Bare GeoJSON Point geometry (not wrapped in a Feature).
  assert.deepEqual(asCoords({ type: "Point", coordinates: [77.6, 12.9] }), { lat: 12.9, lng: 77.6 });
});

test("findMarkerArray drops (0,0) placeholders and dedupes across nested arrays", () => {
  const rows = findMarkerArray({
    clinics:  [{ lat: 12.9, lng: 77.6, name: "A" }, { lat: 0, lng: 0, name: "BAD" }],
    hospitals:[{ lat: 12.9, lng: 77.6, name: "A-dup" }, { lat: 13.0, lng: 77.5, name: "B" }],
  });
  // (0,0) dropped, and A-dup deduped against A by lat/lng tolerance.
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.lat).sort(), [12.9, 13.0]);
});

test("pickBestMarkerEndpoint falls back to neutral URL when nothing scores positive", () => {
  const best = pickBestMarkerEndpoint([
    { url: "https://acme.example.com/data?id=42", type: "xmlhttprequest" },
  ]);
  // Generic /data with no positive-keyword wins over returning null.
  assert.equal(best, "https://acme.example.com/data?id=42");
});

test("toCSV escapes quotes and newlines", () => {
  assert.equal(
    toCSV([{ name: 'A "quoted"\nStore', count: 2 }]),
    'name,count\n"A ""quoted""\nStore",2\n',
  );
});
