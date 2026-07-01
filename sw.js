// sw.js - Service Worker for robust offline audio playback via IndexedDB

const CACHE_NAME = 'base3-shell-v25';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.json', '/images/Base3Logo.jpg'];

const DB_NAME = 'base3-media';
const DB_VERSION = 1;
const inFlight = new Map();

const originalLog = console.log;
const originalError = console.error;

async function broadcastTelemetry(type, payload = {}) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => {
    c.postMessage({ type, ...payload, isTelemetry: true });
  });
}

console.log = (...args) => { originalLog(...args); broadcastTelemetry('SW_LOG', { text: args.join(' ') }); };
console.error = (...args) => { originalError(...args); broadcastTelemetry('SW_LOG', { text: 'ERROR: ' + args.join(' ') }); };

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'trackKey' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => originalLog('[SW] IDB blocked');
  });
}

async function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

function normalizeTrackKey(urlLike) {
  return new URL(urlLike, self.location.origin).pathname;
}

function mimeFromPath(p) {
  if (p.endsWith('.wav')) return 'audio/wav';
  return 'audio/mp4';
}

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of SHELL_ASSETS) {
        try {
          const req = new Request(url, { cache: 'reload' });
          const res = await fetch(req);
          if (res.status === 200) {
            await cache.put(req, res);
          } else {
            originalLog(`[SW] Skip caching ${url} due to status ${res.status}`);
          }
        } catch (err) {
          originalLog(`[SW] Failed to cache ${url}: ${err.message}`);
        }
      }
    })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim().then(() => broadcastTelemetry('SW_READY')));
});

async function serveFromIDB(req) {
  const key = normalizeTrackKey(req.url);
  try {
    const db = await openDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction('tracks', 'readonly');
      const r = tx.objectStore('tracks').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    if (record?.blob) {
      const blob = record.blob;
      const mime = record.mime || 'audio/mp4';
      const rangeHeader = req.headers.get('range');

      if (rangeHeader) {
        const match = rangeHeader.match(/^bytes=(\d+)-(\d+)?$/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : blob.size - 1;
          const chunk = blob.slice(start, end + 1);
          const buffer = await chunk.arrayBuffer();

          return new Response(buffer, {
            status: 206,
            statusText: 'Partial Content',
            headers: {
              'Content-Type': mime,
              'Content-Range': `bytes ${start}-${end}/${blob.size}`,
              'Content-Length': String(chunk.size),
              'Accept-Ranges': 'bytes'
            }
          });
        }
      }

      const buffer = await blob.arrayBuffer();
      return new Response(buffer, {
        headers: {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes'
        }
      });
    }
  } catch (e) {}
  return fetch(req);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/music/')) {
    e.respondWith(serveFromIDB(e.request));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

self.addEventListener('message', e => {
  const { action, url } = e.data || {};
  if (!action) return;
  originalLog(`[SW] Action: ${action} for ${url}`);

  if (action === 'PING') { broadcastTelemetry('PONG'); return; }
  if (!url) return;
  
  const key = normalizeTrackKey(url);

  if (action === 'save') {
    const controller = new AbortController();
    inFlight.set(key, controller);
    (async () => {
      try {
        await broadcastTelemetry('UI_UPDATE', { status: 'downloading', url: key });
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const mime = res.headers.get('Content-Type') || mimeFromPath(key);
        const totalSize = Number.parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
        const reader = res.body?.getReader();
        if (!reader) throw new Error('No reader');

        const chunks = [];
        let receivedBytes = 0;
        let lastUpdateTs = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          receivedBytes += value.byteLength;
          const now = Date.now();
          if (now - lastUpdateTs > 200 || receivedBytes === totalSize) {
            lastUpdateTs = now;
            await broadcastTelemetry('UI_UPDATE', { status: 'downloading', url: key, received: receivedBytes, size: totalSize });
          }
        }

        const blob = new Blob(chunks, { type: mime });
        const db = await openDB();
        await idbPut(db, 'tracks', { trackKey: key, blob, mime, size: blob.size });
        
        await broadcastTelemetry('IDB_WRITE_COMPLETE', { url: key });
        await broadcastTelemetry('UI_UPDATE', { status: 'saved', url: key, size: blob.size });
      } catch (err) {
        if (err.name === 'AbortError') {
          await broadcastTelemetry('UI_UPDATE', { status: 'removed', url: key });
        } else {
          await broadcastTelemetry('UI_UPDATE', { status: 'error', url: key, reason: err.message });
        }
      } finally { inFlight.delete(key); }
    })();
  }
  if (action === 'remove') {
    (async () => {
      try {
        const db = await openDB();
        const tx = db.transaction('tracks', 'readwrite');
        tx.objectStore('tracks').delete(key);
        tx.oncomplete = () => {
          db.close();
          broadcastTelemetry('IDB_RECORD_DELETED', { url: key });
          broadcastTelemetry('UI_UPDATE', { status: 'removed', url: key });
        };
      } catch (err) {}
    })();
  }
  if (action === 'abort') {
    const c = inFlight.get(key);
    if (c) c.abort();
  }
  if (action === 'check') {
    (async () => {
      try {
        const db = await openDB();
        const tx = db.transaction('tracks', 'readonly');
        const req = tx.objectStore('tracks').get(key);
        req.onsuccess = () => {
          const res = req.result;
          db.close();
          broadcastTelemetry('UI_UPDATE', { status: res ? 'saved' : 'removed', url: key, size: res?.blob?.size || 0 });
        };
      } catch(e) {}
    })();
  }
});
