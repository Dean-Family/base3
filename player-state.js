const DB_NAME = 'base3';
const STORE = 'playback_state';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put(value);
  });
}

function idbGet(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get('player');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function wireAudio(audio, urlForTrackKeyFn) {
  const dbPromise = openDB();
  const toKey =
    urlForTrackKeyFn ||
    (a =>
      new URL(
        a.querySelector('source')?.getAttribute('src') || a.currentSrc || a.src || '',
        location.href
      ).pathname);

  audio.dataset.trackKey = toKey(audio);
  let lastWrite = 0;

  async function writeState() {
    const db = await dbPromise;
    const trackKey = audio.dataset.trackKey || toKey(audio);
    await idbPut(db, {
      id: 'player',
      trackKey,
      position: audio.currentTime,
      status: audio.paused ? 'paused' : 'playing',
      updatedAt: Date.now()
    });
  }

  function maybeWrite() {
    const now = Date.now();
    if (now - lastWrite >= 2000) {
      lastWrite = now;
      writeState();
    }
  }

  audio.addEventListener('timeupdate', maybeWrite);
  audio.addEventListener('playing', maybeWrite);
  audio.addEventListener('pause', writeState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') writeState();
  });
}

export async function resumeIfPossible(audio) {
  const db = await openDB();
  const rec = await idbGet(db);
  if (!rec || (rec.status !== 'playing' && rec.status !== 'paused')) return;
  if (audio.dataset.trackKey !== rec.trackKey) return;
  const current = new URL(audio.currentSrc || audio.src || '', location.href).pathname;
  const needsSrc = current !== rec.trackKey;
  if (needsSrc) audio.src = rec.trackKey;

  const seek = async () => {
    audio.currentTime = rec.position || 0;
    if (rec.status === 'playing') {
      try {
        await audio.play();
      } catch (e) {
        /* ignore */
      }
    } else {
      audio.pause();
    }
  };

  if (audio.readyState >= 1 && !needsSrc) {
    seek();
  } else {
    audio.addEventListener('loadedmetadata', seek, { once: true });
  }
}
