// sw.js - Service Worker using IndexedDB for audio storage

const CACHE_NAME = 'base3-shell-v22';
const SHELL_ASSETS = [
  // Only cache assets that don't cause 206 responses
  '/images/Base3Logo.jpg'
];

// IndexedDB setup ----------------------------------------------------------
const DB_NAME = 'base3';
const DB_VERSION = 3;
const inFlight = new Map(); // url -> {controller, lastPostTs}

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
  // Skip shell caching for now - focus on audio caching
  console.log('Service worker installed, skipping shell cache');
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

  if (action === 'test') {
    event.source.postMessage({ status: 'test-ok', url });
  } else if (action === 'check') {
    hasAudioInIDB(url).then((hit) => {
      event.source.postMessage({ status: hit ? 'saved' : 'removed', url });
    }).catch(() => {
      event.source.postMessage({ status: 'removed', url });
    });
  } else if (action === 'save') {
    saveAudioToIDBWithProgress(url, event.source);
  } else if (action === 'remove') {
    removeAudioFromIDB(url).then(() => {
      event.source.postMessage({ status: 'removed', url });
    });
  } else if (action === 'abort') {
    const rec = inFlight.get(url);
    if (rec) rec.controller.abort();
    event.source.postMessage({ status: 'removed', url });
  }
});

async function saveAudioToIDBWithProgress(urlStr, sourceClient) {
  const controller = new AbortController();
  inFlight.set(urlStr, { controller, lastPostTs: 0 });
  
  try {
    sourceClient.postMessage({ status: 'downloading', url: urlStr, received: 0, size: 0 });
    
    const response = await fetch(urlStr, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const contentLength = response.headers.get('Content-Length');
    const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
    
    // Use simple blob approach - avoid streaming issues
    const blob = await response.blob();
    const receivedBytes = blob.size;
    
    // Update progress to show completion
    sourceClient.postMessage({ 
      status: 'downloading', 
      url: urlStr, 
      received: receivedBytes, 
      size: totalSize || receivedBytes 
    });
    
    // Store in IndexedDB
    const url = new URL(urlStr, self.location.origin);
    const key = url.pathname;
    
    console.log('Opening DB for save...');
    const db = await openDB();
    console.log('DB opened, saving blob:', blob.size, 'bytes');
    
    // Real IDB save
    await saveBlobToIDB(db, key, 'audio/mp4', blob);
    console.log('Real IDB save completed');
    
    console.log('About to send saved message...');
    inFlight.delete(urlStr);
    
    const savedMessage = { 
      status: 'saved', 
      url: urlStr, 
      received: blob.size, 
      size: blob.size 
    };
    
    console.log('Sending saved message:', savedMessage);
    sourceClient.postMessage(savedMessage);
    console.log('Saved message sent successfully');
    
  } catch (err) {
    inFlight.delete(urlStr);
    if (err.name === 'AbortError') {
      sourceClient.postMessage({ status: 'removed', url: urlStr });
    } else {
      sourceClient.postMessage({ status: 'error', url: urlStr, reason: err.message });
    }
  }
}

async function saveBlobToIDB(db, key, mime, blob) {
  return new Promise((resolve, reject) => {
    console.log('Real IDB save starting:', key, blob.size);
    
    const tx = db.transaction('tracks', 'readwrite');
    const store = tx.objectStore('tracks');
    
    const record = {
      trackKey: key,
      urlPath: key,
      mime,
      size: blob.size,
      blob: blob, // Store the actual blob
      downloadedAt: Date.now()
    };
    
    console.log('Putting record in IDB...');
    const request = store.put(record);
    
    request.onsuccess = () => {
      console.log('IDB put request succeeded');
    };
    
    request.onerror = () => {
      console.error('IDB put request failed:', request.error);
      reject(request.error);
    };
    
    tx.oncomplete = () => {
      console.log('IDB transaction completed successfully');
      resolve();
    };
    
    tx.onerror = () => {
      console.error('IDB transaction failed:', tx.error);
      reject(tx.error);
    };
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

