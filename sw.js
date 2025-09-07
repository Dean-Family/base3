// sw.js - Service Worker using IndexedDB for audio storage

const CACHE_NAME = 'base3-shell-v2';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/images/Base3Logo.jpg'
];

// IndexedDB setup ----------------------------------------------------------
const DB_NAME = 'base3';
const DB_VERSION = 1;
const inFlight = new Map(); // url -> {controller, lastPostTs}

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
  // Supports: "bytes=START-END", "bytes=START-", "bytes=-SUFFIX"
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (!m) return null;

  let start = m[1] === '' ? undefined : Number(m[1]);
  let end   = m[2] === '' ? undefined : Number(m[2]);
  if (start === undefined && end === undefined) return null;
  if (start !== undefined && (isNaN(start) || start < 0)) return null;
  if (end   !== undefined && (isNaN(end)   || end   < 0)) return null;

  if (start === undefined) {
    // "-SUFFIX" → last N bytes
    const length = Math.min(end, size);
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    if (end === undefined || end >= size) end = size - 1;
  }

  if (start >= size || start > end) return null;
  return { start, end };
}

async function serveFromIDB(request) {
  const url = new URL(request.url);
  const trackKey = url.pathname;
  const db = await openDB();
  const record = await idbGet(db, 'tracks', trackKey);

  if (!record || !record.blob) {
    // No offline copy → network
    return fetch(request);
  }

  const blob = record.blob;
  const mime = record.mime || 'application/octet-stream';
  const size = blob.size;

  if (request.headers.has('range')) {
    const parsed = parseRange(request.headers.get('range'), size);
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

  // Full response
  return new Response(blob, {
    headers: {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size)
    }
  });
}

// Fetch handling -----------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.destination === 'audio' || url.pathname.startsWith('/music/')) {
    event.respondWith(serveFromIDB(req));
    return;
  }

  event.respondWith(caches.match(req).then(r => r || fetch(req)));
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
  } else if (action === 'abort') {
    const rec = inFlight.get(url);
    if (rec) rec.controller.abort('user-abort');
    event.source?.postMessage({ status: 'removed', url });
  }
});

async function saveAudioToIDBWithProgress(urlStr, sourceClient) {
  const controller = new AbortController();
  inFlight.set(urlStr, { controller, lastPostTs: 0 });
  let res;
  try {
    res = await fetch(urlStr, { signal: controller.signal });
  } catch (err) {
    inFlight.delete(urlStr);
    if (err.name === 'AbortError') {
      sourceClient?.postMessage({ status: 'removed', url: urlStr });
    } else {
      sourceClient?.postMessage({ status: 'error', url: urlStr, reason: 'fetch' });
    }
    return;
  }

  if (!res.ok) {
    inFlight.delete(urlStr);
    sourceClient?.postMessage({ status: 'error', url: urlStr, reason: 'network' });
    return;
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    // Fallback for Safari: ReadableStream / getReader not supported
    try {
      const mime = res.headers.get('Content-Type') || 'audio/mp4';
      const url  = new URL(urlStr, self.location.origin);
      const key  = url.pathname;
      const db   = await openDB();

      const blob = await res.blob(); // single-shot
      await saveBlobToIDB(db, key, mime, blob);
      inFlight.delete(urlStr);
      sourceClient?.postMessage({ status: 'saved', url: urlStr, received: blob.size, size: blob.size });
    } catch (err) {
      inFlight.delete(urlStr);
      sourceClient?.postMessage({ status: 'error', url: urlStr, reason: 'no-stream' });
    }
    return; // stop here, we handled the no-stream case
  }

  const size = Number(res.headers.get('Content-Length') || 0);
  const mime = res.headers.get('Content-Type') || 'audio/mp4';
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  const db = await openDB();
  const url = new URL(urlStr, self.location.origin);
  const key = url.pathname;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const rec = inFlight.get(urlStr);
      const now = self.performance?.now?.() || Date.now();
      if (rec && now - rec.lastPostTs >= 120) {
        sourceClient?.postMessage({ status: 'downloading', url: urlStr, received, size });
        rec.lastPostTs = now;
      }
      await idbPut(db, 'downloads', {
        trackKey: key,
        state: 'downloading',
        received,
        size,
        updatedAt: Date.now()
      });
    }
  } catch (err) {
    inFlight.delete(urlStr);
    await idbDelete(db, 'downloads', key);
    if (err.name === 'AbortError') {
      sourceClient?.postMessage({ status: 'removed', url: urlStr });
    } else {
      sourceClient?.postMessage({ status: 'error', url: urlStr, reason: 'read' });
    }
    return;
  }

  let blob;
  try {
    blob = new Blob(chunks, { type: mime });
  } catch (err) {
    inFlight.delete(urlStr);
    await idbDelete(db, 'downloads', key);
    sourceClient?.postMessage({ status: 'error', url: urlStr, reason: 'oom' });
    return;
  }

  try {
    await saveBlobToIDB(db, key, mime, blob);
  } catch (err) {
    inFlight.delete(urlStr);
    await idbDelete(db, 'downloads', key);
    if (err.name === 'QuotaExceededError') {
      let info;
      try {
        const nav = self.navigator;
        if (nav && nav.storage && nav.storage.estimate) {
          const est = await nav.storage.estimate();
          info = { usage: est.usage, quota: est.quota };
        }
      } catch (e) {
        /* ignore */
      }
      const msg = { status: 'error', url: urlStr, reason: 'quota' };
      if (info) msg.info = info;
      sourceClient?.postMessage(msg);
    } else {
      sourceClient?.postMessage({ status: 'error', url: urlStr, reason: 'idb' });
    }
    return;
  }

  inFlight.delete(urlStr);
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

