// The golfer's profile.
//
// Deliberately local: a name, and the two facts that make the measurements
// right rather than assumed. There is no server behind this app, so there is no
// account to create in the usual sense — and rather than dress a local record up
// as one, the prompt says plainly where the data lives.

import { getSettings, setSetting, clamp } from './util.js';

const KEY = 'gsa.profile.v1';

/** The stored profile, or null if the golfer has not made one. */
export function getProfile() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && typeof p.name === 'string' && p.name.trim() ? p : null;
  } catch {
    return null;
  }
}

export function saveProfile({ name, handed, heightCm }) {
  const trimmed = String(name || '').trim().slice(0, 40);
  if (!trimmed) return null;
  const profile = {
    name: trimmed,
    createdAt: getProfile()?.createdAt || Date.now(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    return null;
  }
  // Handedness and height live with the rest of the settings, because the
  // analysis reads them there whether or not a profile exists.
  if (handed) setSetting('handed', handed);
  if (heightCm) setSetting('heightCm', clamp(Number(heightCm) || 178, 120, 220));
  return profile;
}

export function deleteProfile() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to remove */ }
}

/**
 * Whether to offer the profile now.
 *
 * The offer belongs after the first swing has been analysed, not on the way in:
 * nobody wants to be asked who they are before they have been shown anything.
 * Declined once is an answer, so it is remembered and not asked again — the
 * profile stays available in settings for whenever it is actually wanted.
 */
export function shouldOfferProfile() {
  const s = getSettings();
  return !getProfile() && !s.profileDeclined && (s.shotsAnalysed || 0) >= 1;
}

export function declineProfile() {
  setSetting('profileDeclined', true);
}

/** Count a completed analysis, and report the new total. */
export function countAnalysis() {
  const s = getSettings();
  const next = (s.shotsAnalysed || 0) + 1;
  setSetting('shotsAnalysed', next);
  return next;
}

/** First name, or the whole thing if it is one word. */
export function shortName(profile) {
  if (!profile) return '';
  return profile.name.split(/\s+/)[0];
}
