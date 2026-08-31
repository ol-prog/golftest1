// Shot storage. IndexedDB holds the reports, the key-frame stills and (when the
// clip is small enough to be worth it) the video itself, so a session survives
// the phone locking or Safari discarding the tab.

const DB_NAME = 'golf-swing-analyser';
const DB_VERSION = 1;
const STORE = 'shots';

/**
 * Keep a clip unless it is enormous. Slow-motion footage is the whole point of
 * this app and a 1080p 240fps clip runs to tens of megabytes, so the cap has to
 * clear that comfortably; `pruneClips` handles the total rather than the cap
 * doing it one file at a time.
 */
export const MAX_STORED_CLIP_BYTES = 220 * 1024 * 1024;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open local storage.'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted.'));
  }));
}

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Persist a shot. Returns the stored record's id. */
export async function saveShot(shot) {
  const record = { ...shot, id: shot.id || newId() };
  await tx('readwrite', (s) => s.put(record));
  return record.id;
}

export async function getShot(id) {
  return tx('readonly', (s) => new Promise((resolve, reject) => {
    const r = s.get(id);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  }));
}

/** Newest first. */
export async function listShots() {
  const all = await tx('readonly', (s) => new Promise((resolve, reject) => {
    const r = s.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  }));
  return all.sort((a, b) => b.ts - a.ts);
}

export async function deleteShot(id) {
  return tx('readwrite', (s) => s.delete(id));
}

export async function clearShots() {
  return tx('readwrite', (s) => s.clear());
}

/**
 * Drop the video from the oldest shots until storage is comfortable again,
 * keeping their measurements and key frames. Losing the oldest clip of the day
 * beats a save failing outright halfway through a session.
 *
 * Returns how many clips were dropped.
 */
export async function pruneClips({ keepNewest = 6 } = {}) {
  const est = await storageEstimate();
  if (!est || !est.quota || !est.usage) return 0;
  const ceiling = est.quota * 0.7;
  if (est.usage < ceiling) return 0;

  const shots = await listShots();          // newest first
  let freed = 0;
  let dropped = 0;
  const target = est.usage - ceiling;
  // Oldest first, and never touch the most recent few.
  for (let i = shots.length - 1; i >= keepNewest; i--) {
    const shot = shots[i];
    if (!shot.clip) continue;
    freed += shot.clip.size || 0;
    await saveShot({ ...shot, clip: null, clipPruned: true });
    dropped++;
    if (freed >= target) break;
  }
  return dropped;
}

/** Rough usage figure for the settings screen. */
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/**
 * Ask the browser to keep our data rather than evicting it under pressure.
 * Safari grants this silently once the app has been added to the home screen.
 */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
