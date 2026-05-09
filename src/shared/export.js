// src/shared/export.js
// Minimal RFC-4180-ish CSV writer. Handles commas, quotes, newlines.

export function toCSV(rows, columns) {
  if (!rows || rows.length === 0) return "";
  const cols = columns ?? Array.from(
    rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set())
  );
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.map(esc).join(",");
  const body = rows.map(r => cols.map(c => esc(r[c])).join(",")).join("\n");
  return header + "\n" + body + "\n";
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
