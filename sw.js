// sw.js - Service Worker for robust offline audio playback via IndexedDB

const CACHE_NAME = 'base3-shell-v23';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/player-state.js',
  '/images/Base3Logo.jpg'
];

// IndexedDB setup ----------------------------------------------------------
const DB_NAME = 'base3';
const DB_VERSION = 4;
const inFlight = new Map(); // trackKey -> AbortController

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'trackKey' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { keyPath: ['trackKey', 'chunkIndex'] });
      }
      if (!db.objectStoreNames.contains('downloads')) {
        db.createObjectStore('downloads', { keyPath: 'trackKey' });
      }
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('playback_state')) {
        db.createObjectStore('playback_state', { keyPath: 'id' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withStore(db, storeName, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = work(store, tx);

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error(`Transaction aborted for ${storeName}`));
  });
}

async function idbPut(db, storeName, value) {
  return withStore(db, storeName, 'readwrite', store => {
    store.put(value);
  });
}

async function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(db, storeName, key) {
  return withStore(db, storeName, 'readwrite', store => {
    store.delete(key);
  });
}

async function idbDeleteChunks(db, trackKey) {
  return withStore(db, 'chunks', 'readwrite', store => {
    const range = IDBKeyRange.bound([trackKey, 0], [trackKey, Number.MAX_SAFE_INTEGER]);
    store.openCursor(range).onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

function normalizeTrackKey(urlLike) {
  const absolute = new URL(urlLike, self.location.origin);
  return absolute.pathname;
}

function mimeFromPath(pathname) {
  if (pathname.endsWith('.wav')) return 'audio/wav';
  if (pathname.endsWith('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
}

// Caching the application shell -------------------------------------------
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_ASSETS);
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(name => (name === CACHE_NAME ? null : caches.delete(name))));
    await self.clients.claim();
  })());
});

// Helpers -----------------------------------------------------------------
function parseRange(rangeHeader, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (!m) return null;

  let start = m[1] === '' ? undefined : Number(m[1]);
  let end = m[2] === '' ? undefined : Number(m[2]);
  if (start === undefined && end === undefined) return null;
  if (start !== undefined && (!Number.isFinite(start) || start < 0)) return null;
  if (end !== undefined && (!Number.isFinite(end) || end < 0)) return null;

  if (start === undefined) {
    const length = Math.min(end, size);
    start = Math.max(0, size - length);
    end = size - 1;
  } else if (end === undefined || end >= size) {
    end = size - 1;
  }

  if (start >= size || start > end) return null;
  return { start, end };
}

function makeAudioResponse(blob, mime, size, rangeHeader) {
  if (!rangeHeader) {
    return new Response(blob, {
      headers: {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size)
      }
    });
  }

  const parsed = parseRange(rangeHeader, size);
  if (!parsed) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` }
    });
  }

  const { start, end } = parsed;
  const slice = blob.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1)
    }
  });
}

async function serveFromIDBOrNetwork(request) {
  const trackKey = normalizeTrackKey(request.url);

  try {
    const db = await openDB();
    const record = await idbGet(db, 'tracks', trackKey);
    if (record?.blob instanceof Blob) {
      const mime = record.mime || record.blob.type || mimeFromPath(trackKey);
      const size = Number.isFinite(record.size) ? record.size : record.blob.size;
      return makeAudioResponse(record.blob, mime, size, request.headers.get('range'));
    }
  } catch (error) {
    console.error('Failed reading from IDB, falling back to network:', error);
  }

  return fetch(request);
}

// Fetch handling -----------------------------------------------------------
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.destination === 'audio' || url.pathname.startsWith('/music/')) {
    event.respondWith(serveFromIDBOrNetwork(req));
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;

    // Navigations often include query params that should still map to shell.
    if (req.mode === 'navigate') {
      const cachedNav = await caches.match(req, { ignoreSearch: true });
      if (cachedNav) return cachedNav;
    }

    try {
      const response = await fetch(req);
      if (req.method === 'GET' && response.ok && url.origin === self.location.origin) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, response.clone());
      }
      return response;
    } catch (error) {
      // Keep SPA navigation resilient when users launch while offline.
      if (req.mode === 'navigate') {
        const fallback =
          (await caches.match(req, { ignoreSearch: true })) ||
          (await caches.match('/index.html')) ||
          (await caches.match('/'));
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});

// Messaging ---------------------------------------------------------------
self.addEventListener('message', event => {
  const { action, url } = event.data || {};
  const sourceClient = event.source;
  if (!sourceClient || typeof action !== 'string' || typeof url !== 'string') return;

  if (action === 'test') {
    sourceClient.postMessage({ status: 'test-ok', url: normalizeTrackKey(url) });
    return;
  }

  const trackKey = normalizeTrackKey(url);

  if (action === 'check') {
    hasAudioInIDB(trackKey)
      .then(record => {
        sourceClient.postMessage({
          status: record ? 'saved' : 'removed',
          url: trackKey,
          size: record?.size || 0
        });
      })
      .catch(() => {
        sourceClient.postMessage({ status: 'removed', url: trackKey, size: 0 });
      });
    return;
  }

  if (action === 'save') {
    saveAudioToIDBWithProgress(trackKey, sourceClient);
    return;
  }

  if (action === 'remove') {
    removeAudioFromIDB(trackKey)
      .then(() => sourceClient.postMessage({ status: 'removed', url: trackKey, size: 0 }))
      .catch(err => sourceClient.postMessage({ status: 'error', url: trackKey, reason: err.message }));
    return;
  }

  if (action === 'abort') {
    const controller = inFlight.get(trackKey);
    if (controller) controller.abort();
    sourceClient.postMessage({ status: 'removed', url: trackKey, size: 0 });
  }
});

async function saveAudioToIDBWithProgress(trackKey, sourceClient) {
  const active = inFlight.get(trackKey);
  if (active) {
    active.abort();
    inFlight.delete(trackKey);
  }

  const controller = new AbortController();
  inFlight.set(trackKey, controller);

  try {
    sourceClient.postMessage({ status: 'downloading', url: trackKey, received: 0, size: 0 });

    const response = await fetch(trackKey, {
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const mime = response.headers.get('Content-Type') || mimeFromPath(trackKey);
    const totalSize = Number.parseInt(response.headers.get('Content-Length') || '0', 10) || 0;

    const reader = response.body?.getReader();
    if (!reader) throw new Error('ReadableStream not available in this browser');

    const chunks = [];
    let receivedBytes = 0;
    let lastUpdateTs = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!(value instanceof Uint8Array)) continue;
      chunks.push(value);
      receivedBytes += value.byteLength;

      const now = Date.now();
      if (now - lastUpdateTs > 150 || (totalSize && receivedBytes >= totalSize)) {
        lastUpdateTs = now;
        sourceClient.postMessage({
          status: 'downloading',
          url: trackKey,
          received: receivedBytes,
          size: totalSize || receivedBytes
        });
      }
    }

    const blob = new Blob(chunks, { type: mime });
    const finalSize = blob.size;

    const db = await openDB();
    await idbPut(db, 'tracks', {
      trackKey,
      blob,
      mime,
      size: finalSize,
      updatedAt: Date.now()
    });

    await idbPut(db, 'downloads', {
      trackKey,
      status: 'saved',
      size: finalSize,
      updatedAt: Date.now()
    });

    sourceClient.postMessage({
      status: 'saved',
      url: trackKey,
      received: finalSize,
      size: finalSize
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      sourceClient.postMessage({ status: 'removed', url: trackKey, size: 0 });
    } else {
      console.error('Save failed:', err);
      sourceClient.postMessage({ status: 'error', url: trackKey, reason: err?.message || 'unknown' });
    }
  } finally {
    inFlight.delete(trackKey);
  }
}

async function removeAudioFromIDB(trackKey) {
  const db = await openDB();
  await Promise.all([
    idbDelete(db, 'tracks', trackKey),
    idbDelete(db, 'downloads', trackKey),
    idbDeleteChunks(db, trackKey)
  ]);
}

async function hasAudioInIDB(trackKey) {
  const db = await openDB();
  const record = await idbGet(db, 'tracks', trackKey);
  if (record?.blob instanceof Blob && Number.isFinite(record.size)) return record;
  if (record?.blob instanceof Blob) {
    return { ...record, size: record.blob.size };
  }
  return null;
}
