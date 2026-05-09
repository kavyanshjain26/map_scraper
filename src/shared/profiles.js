// src/shared/profiles.js
// Per-site profile storage. A profile remembers, for a given origin:
//   - which adapter worked
//   - the schema hint that produced useful fields
//   - the popup selector path (for debugging / display)
//   - a timestamp (so we can age them out if needed)
//
// Profiles live in chrome.storage.local. They're plain JSON.

const STORAGE_KEY = "mms_profiles_v1";

function normalizeOrigin(urlOrOrigin) {
  try {
    const u = new URL(urlOrOrigin);
    return u.origin;
  } catch {
    return urlOrOrigin;
  }
}

export async function loadProfile(url) {
  const origin = normalizeOrigin(url);
  const { [STORAGE_KEY]: all = {} } = await chrome.storage.local.get(STORAGE_KEY);
  return all[origin] || null;
}

export async function saveProfile(url, profile) {
  const origin = normalizeOrigin(url);
  const { [STORAGE_KEY]: all = {} } = await chrome.storage.local.get(STORAGE_KEY);
  all[origin] = { ...profile, savedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
}

export async function deleteProfile(url) {
  const origin = normalizeOrigin(url);
  const { [STORAGE_KEY]: all = {} } = await chrome.storage.local.get(STORAGE_KEY);
  delete all[origin];
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
}

export async function listProfiles() {
  const { [STORAGE_KEY]: all = {} } = await chrome.storage.local.get(STORAGE_KEY);
  return Object.entries(all).map(([origin, p]) => ({ origin, ...p }));
}
