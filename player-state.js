const DB_NAME = 'base3';
const STORE = 'playback_state';
const DB_VERSION = 5;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, value) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    } catch (e) {
      db.close();
      reject(e);
    }
  });
}

function idbGet(db, id) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => {
        db.close();
        resolve(req.result);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    } catch (e) {
      db.close();
      reject(e);
    }
  });
}

export function wireAudio(audio, urlForTrackKeyFn) {
  // Check for saved state on play
  audio.addEventListener('play', async () => {
    try {
      const trackKey = urlForTrackKeyFn(audio);
      const db = await openDB();
      const state = await idbGet(db, trackKey);
      if (state && state.currentTime) {
        if (Math.abs(audio.currentTime - state.currentTime) > 2) {
          audio.currentTime = state.currentTime;
        }
      }
    } catch (e) {
      /* ignore */
    }
  });

  // Save state periodically
  let lastSave = 0;
  audio.addEventListener('timeupdate', async () => {
    const now = Date.now();
    if (now - lastSave < 2000) return;
    lastSave = now;

    try {
      const trackKey = urlForTrackKeyFn(audio);
      const db = await openDB();
      await idbPut(db, { id: trackKey, currentTime: audio.currentTime, updatedAt: now });
      
      const db2 = await openDB();
      await idbPut(db2, { id: 'last-active-track', trackKey, updatedAt: now });
    } catch (e) {
      /* ignore */
    }
  });
}

export async function resumeIfPossible(audio) {
  try {
    const db = await openDB();
    const last = await idbGet(db, 'last-active-track');
    if (last && last.trackKey) {
      const currentUrl = new URL(audio.currentSrc || audio.src || '', location.href).pathname;
      if (currentUrl === last.trackKey) {
        const db2 = await openDB();
        const state = await idbGet(db2, last.trackKey);
        if (state && state.currentTime) {
          audio.currentTime = state.currentTime;
        }
      }
    }
  } catch (e) {
    /* ignore */
  }
}
