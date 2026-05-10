// Safe schema selector helpers shared by library adapters. User-edited
// selectors are expected, so invalid selectors must not abort a scrape.

export function selectFirstText(root, selector) {
  if (!root || !selector || typeof selector !== "string") return null;
  let el = null;
  try {
    el = root.querySelector(selector);
  } catch (_) {
    return null;
  }
  const text = (el?.textContent || "").trim();
  return text || null;
}

export function applySchemaFields(root, schemaHint) {
  const out = {};
  for (const field of schemaHint?.fields || []) {
    const key = typeof field?.key === "string" ? field.key.trim() : "";
    const selector = typeof field?.selector === "string" ? field.selector.trim() : "";
    if (!key || !selector) continue;
    const text = selectFirstText(root, selector);
    if (text !== null) out[key] = text;
  }
  return out;
}
