// Small escaping helper for strings that are inserted through innerHTML.
// Prefer DOM APIs for form values and attributes; use this only for text
// snippets that are intentionally rendered as HTML.

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
