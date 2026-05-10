// src/content/content-script.js
// Runs in the content-script isolated world. Two jobs:
//   1. Inject src/injected/page-script.js into the page's MAIN world
//      (via a <script type="module"> tag — that's the only way to give it
//      access to window.L, window.google, etc.)
//   2. Bridge messages:
//        sidepanel / service worker  <--chrome.runtime-->  content script
//        content script              <--window.postMessage-->  page script
//
// We inject at document_start (configured in manifest) so the page script
// can hook L.Map etc. BEFORE the site's own code constructs the map.

(() => {
  const TO_PAGE   = "MMS_TO_PAGE";
  const FROM_PAGE = "MMS_FROM_PAGE";
  const BRIDGE_TOKEN = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const heuristicsReady = import(chrome.runtime.getURL("src/content/capture-heuristics.js"));

  // --- 1. Inject page-world script -----------------------------------------
  function inject() {
    // Skip if already injected (e.g. SPA re-navigation where content script
    // persists). The page-world script is idempotent anyway.
    if (document.getElementById("__mms_page_script__")) return;
    const s = document.createElement("script");
    s.id = "__mms_page_script__";
    s.type = "module";
    s.src = `${chrome.runtime.getURL("src/injected/page-script.js")}?token=${encodeURIComponent(BRIDGE_TOKEN)}`;
    s.addEventListener("load", () => s.remove(), { once: true });
    s.addEventListener("error", () => s.remove(), { once: true });
    // Appending to <html> works even before <head> exists at document_start.
    (document.head || document.documentElement).appendChild(s);
  }
  inject();

  // --- 2. Bridge -----------------------------------------------------------

  // Pending requests waiting for a page-script reply.
  const pending = new Map();   // id -> { resolve, reject }
  let nextId = 1;

  function sendToPage(cmd, payload) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const entry = { cmd, resolve, reject, timer: null };
      entry.refreshTimeout = () => {
        clearTimeout(entry.timer);
        const timeoutMs = cmd === "ENUMERATE" ? 120_000 : 30_000;
        entry.timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`page-script timeout for cmd=${cmd}`));
          }
        }, timeoutMs);
      };
      entry.refreshTimeout();
      pending.set(id, entry);
      window.postMessage({ source: TO_PAGE, token: BRIDGE_TOKEN, id, cmd, payload }, "*");
      // Timeout guard — a dead page script shouldn't hang the sidepanel.
    });
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== FROM_PAGE || d.token !== BRIDGE_TOKEN) return;

    // Progress events come with id: -1 and a progress payload. Forward
    // both the progress numbers AND the optional chunk of newly-extracted
    // markers so the sidepanel can render a live preview.
    if (d.id === -1 && d.progress) {
      for (const entry of pending.values()) {
        if (entry.cmd === "ENUMERATE") entry.refreshTimeout();
      }
      chrome.runtime.sendMessage({
        type: "ENUMERATION_PROGRESS",
        payload: d.progress,
        chunk: d.chunk,
      }).catch(() => {});
      return;
    }

    if (typeof d.id !== "number") return;
    const entry = pending.get(d.id);
    if (!entry) return;
    pending.delete(d.id);
    clearTimeout(entry.timer);
    if (d.ok) entry.resolve(d.result);
    else      entry.reject(new Error(d.error || "page-script error"));
  });

  // Handle messages from the side panel / service worker.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case "DETECT_MAPS": {
            const result = await sendToPage("DETECT");
            sendResponse({ ok: true, result });
            break;
          }
          case "ENUMERATE_MARKERS": {
            const result = await sendToPage("ENUMERATE", msg.payload);
            sendResponse({ ok: true, result });
            break;
          }
          case "FIND_DATA_SOURCES": {
            const result = await sendToPage("FIND_DATA_SOURCES", msg.payload);
            sendResponse({ ok: true, result });
            break;
          }
          case "START_TEACH": {
            await startTeach();
            sendResponse({ ok: true });
            break;
          }
          case "STOP_TEACH": {
            stopTeach();
            sendResponse({ ok: true });
            break;
          }
          case "START_PICK": {
            startPick();
            sendResponse({ ok: true });
            break;
          }
          case "START_PICK_LIST": {
            startPickList();
            sendResponse({ ok: true });
            break;
          }
          case "STOP_PICK": {
            stopPick();
            sendResponse({ ok: true });
            break;
          }
          case "FETCH_URL": {
            // Cross-origin fetches with the page's cookies run in the
            // content script's isolated world (same origin as the tab).
            // Used by network-replay mode.
            try {
              const res = await fetch(msg.payload.url, {
                credentials: "include",
                headers: msg.payload.headers || {},
              });
              const text = await res.text();
              sendResponse({ ok: true, result: { status: res.status, text } });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
            break;
          }
          default:
            sendResponse({ ok: false, error: `unknown type ${msg.type}` });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;  // async sendResponse
  });

  // --- 3. Teach flow (sample-pin capture) ----------------------------------
  // Records DOM mutations within ~2s of a user click on the map area.
  // For each newly-added element we also capture its outerHTML and
  // visible text — we ship the single largest addition back as the
  // popup's best-guess HTML so the sidepanel can run schema inference
  // without needing live access to the page's DOM. Network-endpoint
  // hinting is done by the service worker's webRequest buffer.

  let teachActive = false;
  let teachClickHandler = null;
  let teachObserver = null;

  async function startTeach() {
    if (teachActive) return;
    const heuristics = await heuristicsReady;
    teachActive = true;
    await chrome.runtime.sendMessage({ type: "TEACH_CAPTURE_STARTED" }).catch(() => {});

    teachClickHandler = (ev) => {
      document.removeEventListener("click", teachClickHandler, true);
      teachClickHandler = null;
      const target = ev.target;
      const markerSelector = heuristics.deriveMarkerSelector(target);
      const markerCount = markerSelector ? document.querySelectorAll(markerSelector).length : 0;
      const clickInfo = {
        tag: target.tagName,
        cls: typeof target.className === "string" ? target.className : "",
        path: domPath(target),
        time: Date.now(),
      };

      const mutations = [];
      const candidateMap = new Map();
      const rememberCandidate = (node, details = {}) => {
        if (!node || node.nodeType !== 1) return;
        const text = (node.textContent || "").trim();
        if (text.length < 3) return;
        const previous = candidateMap.get(node) || {
          path: domPath(node),
          outerHTML: "",
          text: "",
          textLen: 0,
          becameVisible: false,
          wasEmptyBefore: false,
          reasons: new Set(),
        };
        previous.outerHTML = node.outerHTML || "";
        previous.text = text;
        previous.textLen = text.length;
        previous.becameVisible ||= Boolean(details.becameVisible);
        previous.wasEmptyBefore ||= Boolean(details.wasEmptyBefore);
        if (details.reason) previous.reasons.add(details.reason);
        candidateMap.set(node, previous);
      };
      teachObserver = new MutationObserver((muts) => {
        for (const m of muts) {
          mutations.push({
            type: m.type,
            path: domPath(m.target?.nodeType === 1 ? m.target : m.target?.parentElement),
            attributeName: m.attributeName || null,
          });

          if (m.type === "childList") {
            for (const node of m.addedNodes) {
              if (node.nodeType === 1) {
                rememberCandidate(node, {
                  reason: "added",
                  becameVisible: heuristics.isVisible(node),
                  wasEmptyBefore: true,
                });
              }
            }
          } else if (m.type === "attributes") {
            rememberCandidate(m.target, {
              reason: `attribute:${m.attributeName}`,
              becameVisible: heuristics.isVisible(m.target),
              wasEmptyBefore: (m.oldValue || "").length === 0,
            });
          } else if (m.type === "characterData") {
            rememberCandidate(m.target.parentElement, {
              reason: "text",
              becameVisible: heuristics.isVisible(m.target.parentElement),
              wasEmptyBefore: (m.oldValue || "").trim().length === 0,
            });
          }
        }
      });
      teachObserver.observe(document.body, {
        attributes: true,
        attributeOldValue: true,
        characterData: true,
        characterDataOldValue: true,
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        teachObserver?.disconnect();
        teachObserver = null;

        // Pick the addition with the most text — most likely the popup.
        const candidates = Array.from(candidateMap.values()).map((candidate) => ({
          ...candidate,
          reasons: Array.from(candidate.reasons),
        }));
        const best = heuristics.choosePopupCandidate(candidates);

        chrome.runtime.sendMessage({
          type: "TEACH_SAMPLE_CAPTURED",
          payload: {
            click: clickInfo,
            additions: candidates.map(a => ({ path: a.path, textLen: a.textLen })),
            mutations,
            popupCandidates: candidates,
            popupHTML: best?.outerHTML || null,
            popupPath: best?.path || null,
            markerSelector,
            markerCount,
          },
        }).catch(() => {});
        stopTeach();
      }, 2000);
    };

    // Capture phase so we see the click before the page's own handler runs.
    document.addEventListener("click", teachClickHandler, true);
  }

  function stopTeach() {
    if (teachClickHandler) {
      document.removeEventListener("click", teachClickHandler, true);
      teachClickHandler = null;
    }
    teachObserver?.disconnect();
    teachObserver = null;
    teachActive = false;
    chrome.runtime.sendMessage({ type: "TEACH_CAPTURE_STOPPED" }).catch(() => {});
  }

  function domPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 10) {
      let part = el.tagName.toLowerCase();
      if (el.id) { part += `#${el.id}`; parts.unshift(part); break; }
      if (el.className && typeof el.className === "string") {
        const first = el.className.trim().split(/\s+/)[0];
        if (first) part += `.${first}`;
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }

  // --- 4. Pick mode (visual marker picker) ---------------------------------
  // User enables pick mode from the side panel, hovers the page to highlight
  // the element under cursor, clicks to commit. We then derive a selector
  // that matches every similar element on the page — picking the selector
  // that yields the most hits (but under a sanity cap). The selector feeds
  // DOMAdapter.enumerateMarkers.

  let pickActive = false;
  let pickHighlighted = null;
  let pickMoveHandler = null;
  let pickClickHandler = null;

  function startPick() {
    if (pickActive) return;
    pickActive = true;

    pickMoveHandler = (ev) => {
      const el = ev.target;
      if (pickHighlighted && pickHighlighted !== el) {
        pickHighlighted.classList.remove("__mms_highlight");
      }
      if (el && el !== document.body && el !== document.documentElement) {
        el.classList.add("__mms_highlight");
        pickHighlighted = el;
      }
    };

    pickClickHandler = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const el = ev.target;
      if (!el) return;

      const { deriveMarkerSelector } = await heuristicsReady;
      const selector = deriveMarkerSelector(el);
      const count = selector ? document.querySelectorAll(selector).length : 0;

      chrome.runtime.sendMessage({
        type: "PICK_COMPLETE",
        payload: { selector, count, samplePath: domPath(el) },
      }).catch(() => {});
      stopPick();
    };

    document.addEventListener("mousemove", pickMoveHandler, true);
    document.addEventListener("click", pickClickHandler, true);
    document.body.classList.add("__mms_picking");
  }

  function stopPick() {
    if (pickMoveHandler)  document.removeEventListener("mousemove", pickMoveHandler, true);
    if (pickClickHandler) document.removeEventListener("click", pickClickHandler, true);
    pickMoveHandler = pickClickHandler = null;
    if (pickHighlighted) {
      pickHighlighted.classList.remove("__mms_highlight");
      pickHighlighted = null;
    }
    document.body.classList.remove("__mms_picking");
    pickActive = false;
  }

  function cssEscape(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, (ch) => "\\" + ch);
  }

  // --- 5. Pick-list mode (repeating sidebar/card patterns) ----------------
  // Like pick mode but derives a selector that matches the clicked element's
  // sibling pattern — for scraping dealer cards, store rows, etc.
  let pickListActive = false;
  let pickListMoveHandler = null;
  let pickListClickHandler = null;
  let pickListHighlighted = null;

  function startPickList() {
    if (pickListActive) return;
    pickListActive = true;

    pickListMoveHandler = (ev) => {
      const el = ev.target;
      if (pickListHighlighted && pickListHighlighted !== el) {
        pickListHighlighted.classList.remove("__mms_highlight");
      }
      if (el && el !== document.body && el !== document.documentElement) {
        el.classList.add("__mms_highlight");
        pickListHighlighted = el;
      }
    };

    pickListClickHandler = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const el = ev.target;
      if (!el) return;

      const selector = deriveListSelector(el);
      const count = selector ? document.querySelectorAll(selector).length : 0;

      chrome.runtime.sendMessage({
        type: "PICK_LIST_COMPLETE",
        payload: { selector, count, samplePath: domPath(el) },
      }).catch(() => {});
      stopPickList();
    };

    document.addEventListener("mousemove", pickListMoveHandler, true);
    document.addEventListener("click", pickListClickHandler, true);
    document.body.classList.add("__mms_picking");
  }

  function stopPickList() {
    if (pickListMoveHandler)  document.removeEventListener("mousemove", pickListMoveHandler, true);
    if (pickListClickHandler) document.removeEventListener("click", pickListClickHandler, true);
    pickListMoveHandler = pickListClickHandler = null;
    if (pickListHighlighted) {
      pickListHighlighted.classList.remove("__mms_highlight");
      pickListHighlighted = null;
    }
    document.body.classList.remove("__mms_picking");
    pickListActive = false;
  }

  // Walk up from the clicked element looking for the ancestor whose
  // siblings form a repeating pattern. That ancestor IS a card; its
  // class becomes our selector.
  function deriveListSelector(target) {
    let cur = target;
    const MIN_REPETITIONS = 2;   // at least 3 total (self + 2)
    for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
      const parent = cur.parentElement;
      if (!parent) break;
      const siblings = parent.children;
      if (siblings.length < MIN_REPETITIONS + 1) {
        cur = parent;
        continue;
      }

      // Find a class shared by this element and ≥2 siblings of the same tag.
      if (cur.classList?.length) {
        for (const cls of cur.classList) {
          let matches = 0;
          for (const s of siblings) {
            if (s.tagName === cur.tagName && s.classList.contains(cls)) matches++;
          }
          if (matches >= MIN_REPETITIONS + 1) {
            return `${cur.tagName.toLowerCase()}.${cssEscape(cls)}`;
          }
        }
      }

      // Fall back: same-tag siblings, no class.
      let sameTag = 0;
      for (const s of siblings) if (s.tagName === cur.tagName) sameTag++;
      if (sameTag >= MIN_REPETITIONS + 1 && i > 0) {
        // Use parent class + tag selector.
        const pClass = parent.classList?.[0];
        if (pClass) return `.${cssEscape(pClass)} > ${cur.tagName.toLowerCase()}`;
      }

      cur = parent;
    }
    return null;
  }
})();
