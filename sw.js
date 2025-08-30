// sw.js - Service Worker using IndexedDB for audio storage

const CACHE_NAME = 'base3-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/images/Base3Logo.jpg'
];

// IndexedDB setup ----------------------------------------------------------
const DB_NAME = 'base3';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'trackKey' });
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

function idbPut(db, store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(store).put(value);
  });
}

function idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(store).delete(key);
  });
}

// Caching the application shell -------------------------------------------
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.map(name => (name === CACHE_NAME ? null : caches.delete(name))))
    ).then(() => self.clients.claim())
  );
});

// Helpers -----------------------------------------------------------------
function parseRange(rangeHeader, size) {
  // Supports only single byte range: "bytes=start-end"
  const matches = /^bytes=([0-9]*)-([0-9]*)$/.exec(rangeHeader);
  if (!matches) return null;
  let start = matches[1] === '' ? 0 : Number(matches[1]);
  let end = matches[2] === '' ? size - 1 : Number(matches[2]);
  if (isNaN(start) || isNaN(end) || start > end || end >= size) return null;
  return { start, end };
}

async function serveFromIDB(request) {
  const url = new URL(request.url);
  const trackKey = url.pathname;
  const db = await openDB();
  const record = await idbGet(db, 'tracks', trackKey);

  if (!record || !record.blob) {
    // Not stored offline; fall back to network
    return fetch(request);
  }

  const blob = record.blob;
  const mime = record.mime || 'application/octet-stream';

  if (request.headers.has('range')) {
    const range = parseRange(request.headers.get('range'), blob.size);
    if (range) {
      const slice = blob.slice(range.start, range.end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${blob.size}`
        }
      });
    }
  }

  return new Response(blob, {
    headers: {
      'Content-Type': mime,
      'Content-Length': String(blob.size)
    }
  });
}

// Fetch handling -----------------------------------------------------------
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/music/')) {
    event.respondWith(serveFromIDB(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(resp => resp || fetch(event.request))
  );
});

// Messaging ---------------------------------------------------------------
self.addEventListener('message', (event) => {
  const { action, url } = event.data || {};
  if (!action || !url) return;

  if (action === 'save') {
    event.waitUntil(saveAudioToIDBWithProgress(url, event.source));
  } else if (action === 'remove') {
    event.waitUntil(
      removeAudioFromIDB(url).then(() => {
        event.source?.postMessage({ status: 'removed', url });
      })
    );
  } else if (action === 'check') {
    event.waitUntil(
      hasAudioInIDB(url).then((hit) => {
        event.source?.postMessage({ status: hit ? 'saved' : 'removed', url, ...(hit || {}) });
      })
    );
  }
});

async function saveAudioToIDBWithProgress(urlStr, sourceClient) {
  const res = await fetch(urlStr);
  if (!res.ok || !res.body) {
    sourceClient?.postMessage({ status: 'error', url: urlStr });
    return;
  }

  const size = Number(res.headers.get('Content-Length') || 0);
  const mime = res.headers.get('Content-Type') || 'audio/mp4';
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  const db = await openDB();
  const url = new URL(urlStr, self.location.origin);
  const key = url.pathname;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    sourceClient?.postMessage({ status: 'downloading', url: urlStr, received, size });
    await idbPut(db, 'downloads', {
      trackKey: key,
      state: 'downloading',
      received,
      size,
      updatedAt: Date.now()
    });
  }

  const blob = new Blob(chunks, { type: mime });
  await saveBlobToIDB(db, key, mime, blob);
  sourceClient?.postMessage({ status: 'saved', url: urlStr, received: blob.size, size: blob.size });
}

async function saveBlobToIDB(db, key, mime, blob) {
  await idbPut(db, 'tracks', {
    trackKey: key,
    urlPath: key,
    mime,
    size: blob.size,
    blob,
    downloadedAt: Date.now()
  });
  await idbPut(db, 'downloads', {
    trackKey: key,
    state: 'downloaded',
    received: blob.size,
    size: blob.size,
    updatedAt: Date.now()
  });
}

async function removeAudioFromIDB(urlStr) {
  const url = new URL(urlStr, self.location.origin);
  const key = url.pathname;
  const db = await openDB();
  await idbDelete(db, 'tracks', key);
  await idbDelete(db, 'downloads', key);
}

async function hasAudioInIDB(urlStr) {
  const url = new URL(urlStr, self.location.origin);
  const key = url.pathname;
  const db = await openDB();
  const rec = await idbGet(db, 'tracks', key);
  return rec && rec.blob ? rec : null;
}

