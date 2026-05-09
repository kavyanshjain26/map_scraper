// src/shared/messages.js
// Single source of truth for message types. Importable from service worker
// and side panel (both modules). Content script / page script use a tiny
// duplicate (they can't import from here without a build step) — kept in
// sync by hand. Keep this list short.

export const MSG = Object.freeze({
  // sidepanel -> service worker -> content script
  DETECT_MAPS:       "DETECT_MAPS",
  ENUMERATE_MARKERS: "ENUMERATE_MARKERS",
  START_TEACH:       "START_TEACH",       // enter "click a sample pin" mode
  STOP_TEACH:        "STOP_TEACH",
  CANCEL:            "CANCEL",

  // content script -> service worker -> sidepanel (progress / results)
  DETECTION_RESULT:   "DETECTION_RESULT",
  ENUMERATION_PROGRESS: "ENUMERATION_PROGRESS",
  ENUMERATION_RESULT:   "ENUMERATION_RESULT",
  TEACH_SAMPLE_CAPTURED: "TEACH_SAMPLE_CAPTURED",
  ERROR:              "ERROR",
});

// postMessage "namespace" for content <-> page (MAIN) world bridge.
// The { source } field distinguishes our messages from the page's own.
export const BRIDGE_SRC_TO_PAGE    = "MMS_TO_PAGE";
export const BRIDGE_SRC_FROM_PAGE  = "MMS_FROM_PAGE";
