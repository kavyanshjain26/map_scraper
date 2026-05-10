const LOCATION_TEXT_RE = /\b(?:clinic|hospital|store|branch|office|location|dealer|pharmacy|center|centre|main|directions?)\b/i;
const ADDRESS_RE = /\b\d{1,6}\s+[\w'.\- ]+?\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way|ct|court|pl|place|plaza|hwy|highway|pkwy|parkway)\b/i;
const PHONE_RE = /(?:\+?\d[\d().\- ]{7,}\d)/;
const HOURS_RE = /\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b.*?\d/i;

export function deriveMarkerSelector(target, doc = document) {
  if (!target?.tagName) return null;

  const MAX_HITS = 2000;
  const candidates = collectSelectorCandidates(target);
  let best = null;

  for (const selector of candidates) {
    let nodes = [];
    try {
      nodes = Array.from(doc.querySelectorAll(selector));
    } catch (_) {
      continue;
    }
    if (nodes.length < 1 || nodes.length > MAX_HITS) continue;

    const targetIncluded = nodes.includes(target);
    const avgScore = nodes.reduce((sum, node) => sum + scoreMarkerElement(node), 0) / nodes.length;
    const score =
      avgScore +
      (targetIncluded ? 8 : 0) +
      Math.min(nodes.length, 50) * 0.15 -
      selectorGenericPenalty(selector);

    if (!best || score > best.score) best = { selector, score };
  }

  return best?.selector || null;
}

export function scoreMarkerElement(el) {
  if (!el) return 0;
  let score = 0;
  const tag = el.tagName?.toLowerCase?.() || "";
  const classText = String(el.className || "");
  const title = textAttr(el, "title");
  const ariaLabel = textAttr(el, "aria-label");
  const text = `${title} ${ariaLabel} ${el.textContent || ""}`;
  const style = el.style || {};

  if (tag === "img" || tag === "button" || tag === "svg" || tag === "div") score += 1;
  if (/marker|pin|leaflet-marker|mapboxgl-marker|gm-|place|poi/i.test(classText)) score += 8;
  if (/cluster|count|badge/i.test(classText)) score += 4;
  if (style.position === "absolute" || style.position === "fixed") score += 4;
  if (/translate(?:3d)?\(/i.test(style.transform || "")) score += 6;
  if (title || ariaLabel) score += 3;
  if (LOCATION_TEXT_RE.test(text)) score += 5;
  if (isInsideMapLikeContainer(el)) score += 8;
  if (isInsidePageChrome(el)) score -= 12;
  if (/^(a|button)$/i.test(tag) && !isInsideMapLikeContainer(el)) score -= 4;
  return score;
}

export function choosePopupCandidate(candidates) {
  let best = null;
  for (const candidate of candidates || []) {
    const score = scorePopupCandidate(candidate);
    if (!best || score > best.score) best = { ...candidate, score };
  }
  return best;
}

export function scorePopupCandidate(candidate) {
  if (!candidate) return -Infinity;
  const text = candidate.text || textFromHtml(candidate.outerHTML) || "";
  let score = Math.min(text.length / 40, 8);
  if (candidate.becameVisible) score += 12;
  if (candidate.wasEmptyBefore) score += 8;
  if (ADDRESS_RE.test(text)) score += 8;
  if (PHONE_RE.test(text)) score += 6;
  if (HOURS_RE.test(text)) score += 4;
  if (/get directions|directions|website|call|phone/i.test(text)) score += 6;
  if (/cookie|privacy|newsletter|subscribe|sign up/i.test(text)) score -= 12;
  return score;
}

export function isVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  const win = el.ownerDocument?.defaultView || window;
  const style = win.getComputedStyle ? win.getComputedStyle(el) : el.style || {};
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  if (el.hidden) return false;
  const rect = el.getBoundingClientRect?.();
  return !rect || rect.width > 0 || rect.height > 0;
}

export function isClusterElement(el) {
  const text = (el?.textContent || "").trim();
  const classText = String(el?.className || "");
  return /\b\d{1,5}\b/.test(text) || /cluster|count|badge/i.test(classText);
}

function collectSelectorCandidates(target) {
  const candidates = new Set();
  const tag = target.tagName.toLowerCase();

  for (const cls of target.classList || []) candidates.add(`.${cssEscape(cls)}`);
  if (target.classList?.length) {
    candidates.add(tag + Array.from(target.classList).map((cls) => `.${cssEscape(cls)}`).join(""));
  }

  const ariaLabel = target.getAttribute?.("aria-label");
  if (ariaLabel) candidates.add(`${tag}[aria-label="${cssString(ariaLabel)}"]`);
  const title = target.getAttribute?.("title") || target.title;
  if (title) candidates.add(`${tag}[title="${cssString(title)}"]`);
  candidates.add(tag);

  let parent = target.parentElement;
  let steps = 0;
  while (parent && steps < 4) {
    for (const cls of parent.classList || []) {
      candidates.add(`.${cssEscape(cls)} > ${tag}`);
      candidates.add(`.${cssEscape(cls)} ${tag}`);
    }
    parent = parent.parentElement;
    steps++;
  }

  return Array.from(candidates);
}

function selectorGenericPenalty(selector) {
  if (/^(div|span|button|a|img|svg)$/i.test(selector)) return 15;
  if (/\.icon\b/i.test(selector)) return 6;
  return 0;
}

function isInsideMapLikeContainer(el) {
  return Boolean(el.closest?.("[role='application'], [class*='map'], [class*='leaflet'], [class*='gm-'], [class*='mapbox'], [class*='maplibre']"));
}

function isInsidePageChrome(el) {
  return Boolean(el.closest?.("header, nav, footer"));
}

function textAttr(el, name) {
  return (el.getAttribute?.(name) || el[name] || "").trim?.() || "";
}

function textFromHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^\w-]/g, (ch) => `\\${ch}`);
}

function cssString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
