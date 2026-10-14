// Saved runs live in IndexedDB on the phone. Nothing leaves the device.

const DB_NAME = "runrunrun";
const STORE = "runs";
const ACTIVE_KEY = "runrunrun.activeRun";
const SETTINGS_KEY = "runrunrun.settings";

let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("startedAt", "startedAt");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

export const saveRun = (run) => tx("readwrite", (s) => s.put(run));
export const getRun = (id) => tx("readonly", (s) => s.get(id));
export const deleteRun = (id) => tx("readwrite", (s) => s.delete(id));

export async function listRuns() {
  const runs = await tx("readonly", (s) => s.getAll());
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

// The run in progress is mirrored to localStorage so it survives the page
// being reloaded or killed by iOS mid-run.
export function saveActiveRun(run) {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(run));
  } catch {
    // Storage full or unavailable: the run still lives in memory.
  }
}

export function loadActiveRun() {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_KEY));
  } catch {
    return null;
  }
}

export function clearActiveRun() {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

const DEFAULT_SETTINGS = { unit: "km", voice: true, wakeLock: true };

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}
