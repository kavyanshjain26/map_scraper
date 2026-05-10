// src/sidepanel/sidepanel.js
//
// Unified workflow:
//
//     Step 1: Capture a pin
//       - Runs silent detection first (figures out which map library is there).
//       - Then enters capture mode. On the user's pin click we record three things:
//           (a) the popup HTML  → schema inference
//           (b) the pin element → DOM-click fallback selector
//           (c) recent network requests → candidate JSON endpoints
//     Step 2: Fields (auto-populated, editable)
//     Step 3: Run & export
//
// The Run button internally tries strategies in order until one produces
// a useful result. The user never picks Library vs Network or Capture vs
// Visual picker. If everything fails, the Troubleshoot disclosure in
// Step 3 opens automatically with the visual picker as an escape hatch.

import { MSG }                          from "../shared/messages.js";
import { toCSV, downloadBlob }          from "../shared/export.js";
import { inferSchema }                  from "../shared/schema.js";
import { loadProfile, saveProfile }     from "../shared/profiles.js";
import { networkFetchMarkers,
         pickBestMarkerEndpoint }       from "../shared/network-fetch.js";
import { escapeHtml }                   from "../shared/html.js";
import { chooseDetectedLibrary,
         shouldTryListFirst }           from "./strategy.js";

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ── State ────────────────────────────────────────────────────────────

let lastMarkers        = [];
let detectedAdapter    = null;   // set during silent detection, e.g. "Leaflet"
let detectedInstances  = 0;
let schemaHint         = null;   // { fields, markerSelector? }
let currentUrl         = null;
let currentTabId       = null;
let currentHost        = null;
let recentEndpoints    = [];     // XHR/fetch URLs captured during Capture
let candidateEndpoint  = null;   // best-guess JSON endpoint (auto-chosen)
let teachSamples       = [];
let savedProfileMode   = null;   // "library" | "network" from loaded profile
let detectedListSelector = null; // auto-detected repeating card selector
let detectedListCount    = 0;    // how many cards it matched
let detectedMarkerCount  = null; // marker count after a successful library run

// ── Navigation ───────────────────────────────────────────────────────

// ── Step wizard ──────────────────────────────────────────────────────

const STEPS = ["capture", "fields", "run"];

function setStepState(key, state) {
  const root = $(`#step-${key}`);
  if (!root) return;
  root.classList.remove("in-progress", "done", "step-muted");
  if (state === "in-progress") root.classList.add("in-progress");
  else if (state === "done")    root.classList.add("done");
  else                           root.classList.add("step-muted");
  $(`#state-${key}`).textContent =
    state === "done" ? "Done" :
    state === "in-progress" ? "Active" : "To do";
}
function openStep(key) {
  for (const s of STEPS) $(`#step-${s}`).classList.remove("open");
  $(`#step-${key}`).classList.add("open");
}
function advanceTo(key) {
  const idx = STEPS.indexOf(key);
  for (let i = 0; i < STEPS.length; i++) {
    if (i < idx)       setStepState(STEPS[i], "done");
    else if (i === idx) setStepState(STEPS[i], "in-progress");
    else                setStepState(STEPS[i], "todo");
  }
  openStep(key);
}

// ── Helpers ──────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}
async function refreshCurrentTabContext() {
  const tab = await getActiveTab();
  currentTabId = tab?.id || null;
  currentUrl   = tab?.url || null;
  currentHost  = currentUrl ? new URL(currentUrl).hostname.replace(/^www\./, "") : null;
  return tab;
}
async function loadCurrentTargetProfile() {
  await refreshCurrentTabContext();

  $("#detailContextLabel").textContent = currentHost ? "Active target" : "Target";
  $("#detailContextCopy").textContent = currentHost || "No active tab";

  const p = currentUrl ? await loadProfile(currentUrl) : null;
  if (p) {
    detectedAdapter = p.adapter || null;
    schemaHint = p.schemaHint || null;
    teachSamples = [];
    savedProfileMode = p.mode || null;
    candidateEndpoint = p.networkUrl || null;
    const fieldCount = p.schemaHint?.fields?.length || 0;
    $("#targetStatusPill").textContent = `${fieldCount} saved field${fieldCount === 1 ? "" : "s"}`;
  } else {
    detectedAdapter = null;
    schemaHint = null;
    teachSamples = [];
    savedProfileMode = null;
    candidateEndpoint = null;
    $("#targetStatusPill").textContent = currentUrl ? "Ready" : "No tab";
  }
}
async function sendToTab(type, payload) {
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active tab");
  const reply = await chrome.tabs.sendMessage(tab.id, { type, payload });
  if (!reply?.ok) throw new Error(reply?.error || `${type} failed`);
  return reply.result;
}
function showToast(text) {
  const t = document.createElement("div");
  t.className = "ms-toast";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1600);
}

// Short, friendly description of the detected adapter.
function humanAdapter(name) {
  if (!name) return "unknown";
  if (name === "DOM (generic)") return "a generic DOM map";
  return name;
}

// ── Silent detection (no user interaction needed) ────────────────────

async function runDetection() {
  try {
    const results = await sendToTab(MSG.DETECT_MAPS);

    // Pick best map-library winner that has at least one usable instance.
    const winner = chooseDetectedLibrary(results);
    if (winner) {
      detectedAdapter     = winner.adapter;
      detectedInstances   = winner.instanceCount;
      detectedMarkerCount = null;
    } else {
      detectedAdapter     = null;
      detectedInstances   = 0;
      detectedMarkerCount = null;
    }

    // Separately, check the List adapter's detection result
    const listHit = results.find(r => r.adapter === "List (cards/rows)");
    if (listHit && listHit.confidence > 0) {
      detectedListCount = listHit.instanceCount;
      // Pull the selector from the instance itself if available
      const inst = listHit.instances?.[0];
      detectedListSelector = inst?.selector || null;
      // Pre-populate schemaHint with list selector so auto-strategy can use it
      if (detectedListSelector && !schemaHint?.listSelector) {
        schemaHint = { ...(schemaHint || {}), fields: schemaHint?.fields || [], listSelector: detectedListSelector };
      }
    } else {
      detectedListCount = 0;
      detectedListSelector = null;
    }

    return winner;
  } catch (e) {
    detectedAdapter = null;
    detectedInstances = 0;
    detectedMarkerCount = null;
    detectedListCount = 0;
    detectedListSelector = null;
    return null;
  }
}

// ── Endpoint heuristic: pick the most marker-looking URL ─────────────

function pickBestEndpoint(requests) {
  return pickBestMarkerEndpoint(requests);
}

// ── Renderers ────────────────────────────────────────────────────────

function renderSchema(hint) {
  const box = $("#schemaFields");
  box.innerHTML = "";
  const fields = hint?.fields || [];
  if (fields.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No fields yet. Capture a pin, or add one manually.";
    box.appendChild(p);
    return;
  }
  for (const [i, f] of fields.entries()) {
    const row = document.createElement("div");
    row.className = "field-row";

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.value = f.key || "";
    keyInput.dataset.idx = String(i);
    keyInput.dataset.what = "key";
    keyInput.placeholder = "key";

    const selectorInput = document.createElement("input");
    selectorInput.type = "text";
    selectorInput.value = f.selector || "";
    selectorInput.dataset.idx = String(i);
    selectorInput.dataset.what = "selector";
    selectorInput.placeholder = "selector";

    const deleteButton = document.createElement("button");
    deleteButton.dataset.idx = String(i);
    deleteButton.dataset.what = "delete";
    deleteButton.title = "Remove";
    deleteButton.textContent = "×";

    row.append(keyInput, selectorInput, deleteButton);
    box.appendChild(row);
  }
}

function renderPreview(markers) {
  const wrap  = $("#livePreview");
  const head  = $("#previewHead");
  const body  = $("#previewBody");
  const count = $("#previewCountLabel");

  if (!markers.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  count.textContent = `${markers.length} marker${markers.length === 1 ? "" : "s"}`;

  const seen = new Set();
  for (const m of markers.slice(0, 30)) for (const k of Object.keys(m)) seen.add(k);
  const cols = Array.from(seen);

  head.innerHTML = "<tr>" + cols.map(c => `<th>${escapeHtml(c)}</th>`).join("") + "</tr>";
  body.innerHTML = markers.slice(0, 30).map(m =>
    "<tr>" + cols.map(c => {
      const v = m[c];
      return `<td>${escapeHtml(v === null || v === undefined ? "" : String(v))}</td>`;
    }).join("") + "</tr>"
  ).join("");
}

function updateRunProgress(done, total) {
  const fill = $("#runProgressFill");
  const txt  = $("#runCountText");
  const eta  = $("#runEtaText");
  const pct = total > 0 ? (done / total) * 100 : 0;
  fill.style.width = pct + "%";
  txt.textContent = total > 0 ? `${done} / ${total}` : `${done}`;
  if (total > 0 && done > 0 && done < total) {
    eta.textContent = `Extracting marker ${done} of ${total}…`;
  } else if (done === total && total > 0) {
    eta.textContent = `Collected ${total} marker${total === 1 ? "" : "s"}.`;
  }
}

// ── Bootstrap / profile load ─────────────────────────────────────────

async function bootstrap() {
  await loadCurrentTargetProfile();
  renderSchema(schemaHint);
  if (schemaHint?.fields?.length) {
    advanceTo("run");
  } else {
    advanceTo("capture");
  }
}
bootstrap();

// ── Step heads: click to expand ──────────────────────────────────────

$$(".step-head").forEach(head => {
  head.addEventListener("click", () => {
    const key  = head.dataset.open;
    const step = $(`#step-${key}`);
    if (step.classList.contains("open")) step.classList.remove("open");
    else { openStep(key); }
  });
});

// ── Step 1: Capture (detection happens silently here) ────────────────

$("#btnCapture").addEventListener("click", async () => {
  const btn = $("#btnCapture");
  btn.disabled = true;
  btn.textContent = "Detecting…";
  $("#captureDetected").textContent = "";
  $("#captureResult").textContent   = "";

  // 1. Silent detection — runs before we arm click capture.
  await runDetection();

  // Build a friendly summary: library + list + endpoints
  const bits = [];
  if (detectedAdapter) {
    bits.push(`${humanAdapter(detectedAdapter)}${detectedInstances > 1 ? ` ×${detectedInstances}` : ""}`);
  }
  if (detectedListCount > 0) {
    bits.push(`${detectedListCount} list items`);
  }
  if (bits.length === 0) {
    $("#captureDetected").textContent = "No map or list pattern detected. Click a pin or card to help us find it.";
  } else {
    $("#captureDetected").textContent = "Found: " + bits.join(" + ") + ".";
  }

  // 2. Arm non-blocking capture. The content script records the clicked
  // element's selector without cancelling the click, so the page can still
  // open the popup for schema inference.
  btn.textContent = "Click a pin on the page…";
  try {
    await sendToTab("START_TEACH");
  } catch (e) {
    $("#captureResult").textContent = "Error arming capture: " + e.message;
    btn.disabled = false;
    btn.textContent = "Capture a pin";
    return;
  }
});

// When either capture event comes back, update state and, once the
// popup-capture (the primary one) has landed, advance the wizard.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.TEACH_SAMPLE_CAPTURED) {
    const p = msg.payload;
    // Schema from popup HTML
    if (p.popupHTML) {
      teachSamples.push(p.popupHTML);
      schemaHint = mergeSchemas(teachSamples.map((html) => inferSchema(html)));
      renderSchema(schemaHint);
    }
    if (p.markerSelector) {
      schemaHint = { ...(schemaHint || {}), fields: schemaHint?.fields || [], markerSelector: p.markerSelector };
      renderSchema(schemaHint);
    }
    // Capture recent network requests for the auto-strategy Run
    chrome.runtime.sendMessage({ type: "GET_RECENT_REQUESTS" }, (reply) => {
      if (!reply?.ok) return;
      const since = p.click.time - 3000;
      recentEndpoints = reply.list
        .filter(r => r.ts >= since && (r.type === "xmlhttprequest" || r.type === "fetch"))
        .slice(-40);
      candidateEndpoint = pickBestEndpoint(recentEndpoints);
    });

    // UI update
    const bits = [];
    bits.push(detectedAdapter ? `Library: ${humanAdapter(detectedAdapter)}` : "Library: generic");
    bits.push(schemaHint?.fields?.length ? `Fields found: ${schemaHint.fields.length}` : "No popup fields found");
    if (p.markerSelector) bits.push(`Pin selector: ${p.markerCount || 0} matches`);
    $("#captureResult").textContent = bits.join(" · ");

    $("#btnCapture").disabled = false;
    $("#btnCapture").textContent = "Capture another pin";
    setStepState("capture", "done");
    advanceTo("fields");
    return;
  }

  if (msg?.type === "PICK_COMPLETE") {
    const p = msg.payload;
    if (p.selector) {
      schemaHint = { ...(schemaHint || {}), fields: schemaHint?.fields || [], markerSelector: p.selector };
      const pickResult = $("#pickResult");
      if (pickResult) pickResult.textContent = `Pin selector: ${p.selector}  (${p.count} matches)`;
    }
    return;
  }

  if (msg?.type === "PICK_LIST_COMPLETE") {
    const p = msg.payload;
    if (p.selector) {
      schemaHint = { ...(schemaHint || {}), fields: schemaHint?.fields || [], listSelector: p.selector };
      detectedListCount = p.count;
      detectedListSelector = p.selector;
      const pickResult = $("#pickResult");
      if (pickResult) pickResult.textContent = `List selector: ${p.selector}  (${p.count} cards)`;
      showToast(`${p.count} cards detected`);
    }
    return;
  }

  if (msg?.type === MSG.ENUMERATION_PROGRESS) {
    const { done, total } = msg.payload;
    updateRunProgress(done, total);
    if (msg.chunk && msg.chunk.length) {
      lastMarkers = lastMarkers.concat(msg.chunk);
      renderPreview(lastMarkers);
    }
    return;
  }
});

function mergeSchemas(schemas) {
  const fields = [];
  const seenKeys = new Set();
  const seenSelectors = new Set();
  for (const schema of schemas) {
    for (const field of schema?.fields || []) {
      if (!field.key || !field.selector) continue;
      if (seenKeys.has(field.key) || seenSelectors.has(field.selector)) continue;
      seenKeys.add(field.key);
      seenSelectors.add(field.selector);
      fields.push(field);
    }
  }
  return { ...(schemaHint || {}), fields };
}

// ── Step 2: Fields ───────────────────────────────────────────────────

$("#schemaFields").addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.tagName !== "INPUT") return;
  const idx = Number(t.dataset.idx);
  const what = t.dataset.what;
  if (!schemaHint?.fields?.[idx]) return;
  schemaHint.fields[idx][what] = t.value;
});
$("#schemaFields").addEventListener("click", (ev) => {
  const t = ev.target;
  if (t.tagName !== "BUTTON" || t.dataset.what !== "delete") return;
  const idx = Number(t.dataset.idx);
  schemaHint.fields.splice(idx, 1);
  renderSchema(schemaHint);
});
$("#btnAddField").addEventListener("click", () => {
  if (!schemaHint) schemaHint = { fields: [] };
  if (!schemaHint.fields) schemaHint.fields = [];
  schemaHint.fields.push({ key: "", selector: "" });
  renderSchema(schemaHint);
});
$("#btnFieldsNext").addEventListener("click", () => {
  setStepState("fields", "done");
  advanceTo("run");
});

// ── Step 3: Run (auto-strategy) ──────────────────────────────────────

/**
 * Try strategies in order, return the first that produces markers.
 * Order:
 *   1. Library mode (if we have a detected adapter)
 *   2. Network mode (if we have a candidate JSON endpoint)
 *   3. DOM-click mode (if we have a pin selector from the picker)
 *
 * We log each attempt so Troubleshoot can show what was tried.
 */
async function runAutoStrategy() {
  const attempts = [];

  await refreshCurrentTabContext();
  if (!detectedAdapter) await runDetection();

  // Strategy 1: page-exposed data arrays. This is fastest when the site
  // already keeps all locations in a window-level store.
  try {
    updateRunProgress(0, 0);
    $("#runEtaText").textContent = "Looking for page data…";
    const result = await sendToTab(MSG.FIND_DATA_SOURCES, { limit: 5000 });
    attempts.push({ name: "Page data source", count: result.count, ok: result.count > 0, source: result.source });
    if (result.count > 0) {
      lastMarkers = result.markers;
      renderPreview(lastMarkers);
      updateRunProgress(lastMarkers.length, lastMarkers.length);
      return { strategy: "page-data", markers: lastMarkers, attempts };
    }
  } catch (e) {
    attempts.push({ name: "Page data source", error: e.message, ok: false });
  }

  // Strategy 2: captured/fetched JSON endpoints.
  const endpoint = candidateEndpoint || pickBestEndpoint(recentEndpoints) || (savedProfileMode === "network" ? candidateEndpoint : null);
  if (endpoint && currentTabId) {
    try {
      $("#runEtaText").textContent = "Trying API endpoint…";
      updateRunProgress(0, 0);
      const markers = await networkFetchMarkers(currentTabId, endpoint);
      attempts.push({ name: "API endpoint", endpoint, count: markers.length, ok: markers.length > 0 });
      if (markers.length > 0) {
        lastMarkers = markers;
        candidateEndpoint = endpoint;
        renderPreview(lastMarkers);
        updateRunProgress(markers.length, markers.length);
        return { strategy: "network", markers, attempts };
      }
    } catch (e) {
      attempts.push({ name: "API endpoint", endpoint, error: e.message, ok: false });
    }
  }

  // Strategy 3: List mode (sidebar/cards), but only before library mode
  // when no usable library was detected. Library marker count is unknown
  // until enumeration finishes, so list count cannot be compared up front.
  const hasListTeaching = !!schemaHint?.listSelector;
  const tryListFirst = shouldTryListFirst({ hasListTeaching, detectedAdapter });

  const deepScan = $("#chkDeepScan")?.checked || false;

  if (tryListFirst) {
    try {
      updateRunProgress(0, 0);
      $("#runEtaText").textContent = "Reading the list…";
      const result = await sendToTab(MSG.ENUMERATE_MARKERS, {
        adapterName: "List (cards/rows)",
        instanceIndex: 0,
        expandClusters: false,
        deepScan: false,
        schemaHint,
      });
      attempts.push({ name: "List (cards/rows)", count: result.count, ok: result.count > 0 });
      if (result.count > 0) {
        lastMarkers = result.markers;
        renderPreview(lastMarkers);
        updateRunProgress(lastMarkers.length, lastMarkers.length);
        return { strategy: "list", markers: lastMarkers, attempts };
      }
    } catch (e) {
      attempts.push({ name: "List (cards/rows)", error: e.message, ok: false });
    }
  }

  // Strategy 4: Library mode
  if (detectedAdapter) {
    try {
      updateRunProgress(0, 0);
      $("#runEtaText").textContent = deepScan
        ? `Deep-scanning ${humanAdapter(detectedAdapter)} (panning the map)…`
        : `Trying ${humanAdapter(detectedAdapter)}…`;
      lastMarkers = [];
      renderPreview([]);
      const result = await sendToTab(MSG.ENUMERATE_MARKERS, {
        adapterName: detectedAdapter,
        instanceIndex: 0,
        expandClusters: $("#chkClusters").checked,
        deepScan,
        schemaHint,
        mode: "library",
      });
      attempts.push({ name: `Map library (${detectedAdapter})`, count: result.count, ok: result.count > 0 });
      if (result.count > 0) {
        lastMarkers = result.markers;
        detectedMarkerCount = result.count;
        renderPreview(lastMarkers);
        return { strategy: "library", markers: lastMarkers, attempts };
      }
      if (detectedAdapter === "Mapbox GL") {
        $("#runEtaText").textContent = "Panning map grid...";
        const panResult = await sendToTab(MSG.ENUMERATE_MARKERS, {
          adapterName: detectedAdapter,
          instanceIndex: 0,
          expandClusters: $("#chkClusters").checked,
          schemaHint,
          mode: "pan",
        });
        attempts.push({ name: "Mapbox pan grid", count: panResult.count, ok: panResult.count > 0 });
        if (panResult.count > 0) {
          lastMarkers = panResult.markers;
          detectedMarkerCount = panResult.count;
          renderPreview(lastMarkers);
          return { strategy: "pan", markers: lastMarkers, attempts };
        }
      }
    } catch (e) {
      attempts.push({ name: `Map library (${detectedAdapter})`, error: e.message, ok: false });
    }
  }

  // Strategy 5: List mode (if we didn't try it first)
  if (hasListTeaching && !tryListFirst) {
    try {
      updateRunProgress(0, 0);
      $("#runEtaText").textContent = "Reading the list…";
      const result = await sendToTab(MSG.ENUMERATE_MARKERS, {
        adapterName: "List (cards/rows)",
        instanceIndex: 0,
        expandClusters: false,
        deepScan: false,
        schemaHint,
      });
      attempts.push({ name: "List (cards/rows)", count: result.count, ok: result.count > 0 });
      if (result.count > 0) {
        lastMarkers = result.markers;
        renderPreview(lastMarkers);
        updateRunProgress(lastMarkers.length, lastMarkers.length);
        return { strategy: "list", markers: lastMarkers, attempts };
      }
    } catch (e) {
      attempts.push({ name: "List (cards/rows)", error: e.message, ok: false });
    }
  }

  // Strategy 6: DOM-click fallback
  if (schemaHint?.markerSelector) {
    try {
      $("#runEtaText").textContent = "Trying DOM click…";
      updateRunProgress(0, 0);
      lastMarkers = [];
      renderPreview([]);
      const result = await sendToTab(MSG.ENUMERATE_MARKERS, {
        adapterName: "DOM (generic)",
        instanceIndex: 0,
        expandClusters: $("#chkClusters").checked,
        deepScan: false,
        schemaHint,
        mode: $("#chkClusters").checked ? "zoom" : "dom",
      });
      attempts.push({ name: "DOM click", count: result.count, ok: result.count > 0 });
      if (result.count > 0) {
        lastMarkers = result.markers;
        renderPreview(lastMarkers);
        return { strategy: "dom", markers: lastMarkers, attempts };
      }
    } catch (e) {
      attempts.push({ name: "DOM click", error: e.message, ok: false });
    }
  }

  return { strategy: null, markers: [], attempts };
}

$("#btnRun").addEventListener("click", async () => {
  const btn = $("#btnRun");
  btn.disabled = true;
  btn.textContent = "Running…";
  setStepState("run", "in-progress");
  $("#advancedPanel").hidden = true;

  try {
    const result = await runAutoStrategy();

    if (result.markers.length === 0) {
      // Everything failed. Open Troubleshoot with diagnostic info.
      const lines = result.attempts.map(a =>
        a.ok
          ? `✓ ${a.name}: ${a.count} markers`
          : a.error
            ? `✗ ${a.name}: ${a.error}`
            : `✗ ${a.name}: 0 markers`
      );
      $("#runEtaText").textContent = "No markers found. See Troubleshoot below.";
      $("#advancedPanel").hidden = false;
      $("#advancedPanel").open   = true;
      $("#advancedEndpoints").innerHTML =
        lines.length
          ? `<p class="hint">Tried:</p><pre class="note">${escapeHtml(lines.join("\n"))}</pre>`
          : "";
      setStepState("run", "in-progress");
    } else {
      $("#runEtaText").textContent =
        `Collected ${result.markers.length} marker${result.markers.length === 1 ? "" : "s"}.`;
      $("#exportActions").hidden = false;
      setStepState("run", "done");
    }
  } catch (e) {
    $("#runEtaText").textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run again";
  }
});

// ── Troubleshoot: visual picker (escape hatch) ───────────────────────

$("#btnPick").addEventListener("click", async () => {
  $("#pickResult").textContent = "Hover a pin on the page, then click to commit.";
  await sendToTab("START_PICK");
});

$("#btnPickList")?.addEventListener("click", async () => {
  $("#pickResult").textContent = "Hover a card/row, then click to commit.";
  await sendToTab("START_PICK_LIST");
});

// ── Exports ──────────────────────────────────────────────────────────

$("#btnExportCsv").addEventListener("click", () => {
  const csv = toCSV(lastMarkers);
  downloadBlob(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }), "markers.csv");
});
$("#btnExportJson").addEventListener("click", () => {
  downloadBlob(
    new Blob([JSON.stringify(lastMarkers, null, 2)], { type: "application/json" }),
    "markers.json"
  );
});
$("#btnCopyTsv").addEventListener("click", async () => {
  const cols = Array.from(lastMarkers.reduce((s, r) => {
    Object.keys(r).forEach(k => s.add(k)); return s;
  }, new Set()));
  const header = cols.join("\t");
  const body = lastMarkers.map(r => cols.map(c => {
    const v = r[c];
    return v == null ? "" : String(v).replace(/[\t\r\n]/g, " ");
  }).join("\t")).join("\n");
  try {
    await navigator.clipboard.writeText(header + "\n" + body);
    showToast(`${lastMarkers.length} rows copied`);
  } catch (e) {
    showToast("Copy failed — " + e.message);
  }
});

$("#btnSaveProfile").addEventListener("click", async () => {
  await refreshCurrentTabContext();
  if (!currentUrl) return;
  // We still store "mode" for backwards compat with older profiles, but
  // the UI never shows it.
  const mode = candidateEndpoint && detectedAdapter === null ? "network" : "library";
  await saveProfile(currentUrl, {
    mode,
    adapter: detectedAdapter,
    schemaHint,
    networkUrl: candidateEndpoint || null,
  });
  const fieldCount = schemaHint?.fields?.length || 0;
  $("#targetStatusPill").textContent = `${fieldCount} saved field${fieldCount === 1 ? "" : "s"}`;
  showToast("Profile saved");
});
