// src/shared/schema.js
// Schema inference: given the HTML of a popup (or any container revealed
// after a user's teach-mode click), guess which elements carry which
// fields. The output plugs straight into each adapter's extractMarkerData
// via the schemaHint argument.
//
// Heuristics, cheapest to most specific. Nothing here is ML — just rules
// that cover the common patterns you see on store locators.

const ADDRESS_RE = /\b\d{1,6}\s+[\w'.\- ]+?\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way|ct|court|pl|place|plaza|hwy|highway|pkwy|parkway)\b/i;
const ZIP_RE     = /\b\d{5}(?:-\d{4})?\b/;
const PHONE_RE   = /(?:\+?\d[\d().\- ]{7,}\d)/;
const HOURS_RE   = /\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b.*?\d/i;

/**
 * Main entry. Accepts either an HTML string or a DOM node. Returns
 *   { fields: [ { key, selector }, ... ] }
 * where selectors are usable with querySelector on a similarly-shaped
 * popup.
 *
 * The selectors we generate are path-based (tag > tag.class > ...) so
 * they survive across repeated popups on the same site without leaning
 * on brittle nth-child indexes.
 */
export function inferSchema(input) {
  const root = typeof input === "string"
    ? new DOMParser().parseFromString(input, "text/html").body
    : input;
  if (!root) return { fields: [] };

  const fields = [];
  const seen = new Set();      // field keys we've already bound
  const seenSelectors = new Set();

  const push = (key, el, overrideSelector = null) => {
    if (!el || seen.has(key)) return;
    const sel = overrideSelector ?? cssPath(el, root);
    if (!sel || seenSelectors.has(sel)) return;
    fields.push({ key, selector: sel });
    seen.add(key);
    seenSelectors.add(sel);
  };

  // 1. Name: first heading, or the boldest text in the first 3 nodes.
  const heading = root.querySelector("h1, h2, h3, h4, [role='heading']");
  if (heading) push("name", heading);

  // 2. Links with special schemes. Use attribute selectors directly —
  //    they're unambiguous and survive DOM wrapping differences between
  //    popups.
  const tel = root.querySelector('a[href^="tel:"]');
  if (tel) push("phone", tel, 'a[href^="tel:"]');

  const email = root.querySelector('a[href^="mailto:"]');
  if (email) push("email", email, 'a[href^="mailto:"]');

  const web = Array.from(root.querySelectorAll("a[href]")).find(a => {
    const h = a.getAttribute("href") || "";
    return /^https?:/i.test(h) && !h.includes("maps.google") && !h.includes("tel:");
  });
  if (web) push("website", web);

  // 3. Text-pattern fields — walk visible text nodes and match regexes.
  //    We record the innermost element containing the match, not the
  //    match span itself, so the selector points at a stable element.
  //    Use root.ownerDocument — root may belong to a different document
  //    (e.g. when it comes from a DOMParser, or from the page's window).
  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.nodeValue?.trim();
    if (!t || t.length < 3) continue;
    const el = node.parentElement;
    if (!el) continue;

    if (!seen.has("address") && ADDRESS_RE.test(t)) push("address", el);
    else if (!seen.has("zip")   && ZIP_RE.test(t) && !seen.has("address")) {
      // If we got a zip before an address, hold it — address usually
      // contains the zip anyway and is more useful.
    }
    if (!seen.has("phone") && PHONE_RE.test(t) && !/[a-zA-Z]/.test(t.slice(-6))) {
      push("phone", el);
    }
    if (!seen.has("hours") && HOURS_RE.test(t)) push("hours", el);
  }

  return { fields };
}

/**
 * Build a short, stable-ish CSS selector from `el` rooted at `root`.
 * Prefers class names over nth-child. Capped at 4 segments — longer
 * paths become fragile.
 */
function cssPath(el, root) {
  if (!el || el === root) return "";
  const parts = [];
  let cur = el;
  while (cur && cur !== root && parts.length < 4) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) { seg = `#${cssEscape(cur.id)}`; parts.unshift(seg); break; }
    if (cur.classList && cur.classList.length > 0) {
      // Prefer a class that looks semantic (longer, not purely generated).
      const cls = Array.from(cur.classList)
        .filter(c => !/^[a-z]{1,3}[-_]?\d+$/i.test(c))   // drop "css-1ab2" style
        .sort((a, b) => b.length - a.length)[0];
      if (cls) seg += `.${cssEscape(cls)}`;
    }
    parts.unshift(seg);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

// CSS.escape fallback — CSS.escape is everywhere in Chrome, but guard
// anyway (tests, ancient browsers, non-DOM contexts).
function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  // Minimal fallback: escape anything that isn't alnum / dash / underscore.
  return String(s).replace(/[^\w-]/g, (ch) => "\\" + ch);
}

/**
 * Given a captured teach payload (click info + DOM additions), pick the
 * most likely popup root from the additions and infer its schema. Used
 * by the sidepanel when the user finishes teach mode.
 *
 * `additions` is an array of stringified DOM paths (from the content
 * script's MutationObserver). We can't use those directly — we need the
 * live elements. So we try each path's selector and take the one whose
 * element contains the richest text content.
 */
export function inferSchemaFromTeach(additions) {
  if (!additions || additions.length === 0) return { fields: [] };

  // Try the last few additions (latest = most likely the popup root).
  const candidates = additions.slice(-10).reverse();
  for (const path of candidates) {
    const lastSeg = path.split(" > ").pop();
    if (!lastSeg) continue;
    let el = null;
    try { el = document.querySelector(lastSeg); } catch (_) { continue; }
    if (!el) continue;
    const text = (el.textContent || "").trim();
    if (text.length < 20) continue;    // too small to be a popup
    return inferSchema(el);
  }
  return { fields: [] };
}
