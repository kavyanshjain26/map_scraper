// src/background/service-worker.js
// MV3 service worker. Three jobs:
//   1. Open the side panel when the action icon is clicked.
//   2. Relay messages between sidepanel <-> content script when the
//      sidepanel needs to send to a specific tab.
//   3. Capture network requests during the "teach" flow. webRequest in MV3
//      is observe-only (no blocking without declarativeNetRequest), which
//      is all we need here.

import { MSG } from "../shared/messages.js";

// 1. Sidepanel setup — open on action click.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn("setPanelBehavior:", e));

// 2. Routing helper for the sidepanel: "send this to the active tab's content script".
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "FORWARD_TO_ACTIVE_TAB") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) { sendResponse({ ok: false, error: "no active tab" }); return; }
        const reply = await chrome.tabs.sendMessage(tab.id, msg.inner);
        sendResponse({ ok: true, reply });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 3. Teach flow: the content script tells us when a sample click happened.
  //    We also have teach-window network capture (below) — forward everything
  //    to the sidepanel.
  if (msg?.type === MSG.TEACH_SAMPLE_CAPTURED) {
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }
});

// 3b. Simple webRequest buffer, keyed by tab id. The sidepanel can ask for
//     recent requests when a teach sample lands. We only keep the last N
//     per tab to bound memory.
const RECENT = new Map();   // tabId -> [{url, method, type, ts}]
const MAX_PER_TAB = 200;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const list = RECENT.get(details.tabId) || [];
    list.push({
      url: details.url,
      method: details.method,
      type: details.type,
      ts: details.timeStamp,
    });
    if (list.length > MAX_PER_TAB) list.shift();
    RECENT.set(details.tabId, list);
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener((tabId) => RECENT.delete(tabId));

// Expose the buffer to the sidepanel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GET_RECENT_REQUESTS") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      sendResponse({ ok: true, list: RECENT.get(tab?.id) || [] });
    })();
    return true;
  }
});
