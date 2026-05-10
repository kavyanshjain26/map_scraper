const NON_LIBRARY_ADAPTERS = new Set(["List (cards/rows)", "DOM (generic)"]);

export function chooseDetectedLibrary(results) {
  return (results || [])
    .filter((result) =>
      result &&
      !NON_LIBRARY_ADAPTERS.has(result.adapter) &&
      result.confidence > 0 &&
      result.instanceCount > 0
    )
    .sort((a, b) => b.confidence - a.confidence)[0] || null;
}

export function shouldTryListFirst({ hasListTeaching, detectedAdapter }) {
  return Boolean(hasListTeaching && !detectedAdapter);
}
